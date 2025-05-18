const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const xlsx = require('xlsx');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const bodyParser = require('body-parser');
const qrcode = require('qrcode');

const app = express();
const port = process.env.PORT || 3000;

// Directories
const uploadDir = path.join(__dirname, 'uploads');
const LOG_FILE = path.join(__dirname, 'logs.json');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '[]');

// Express middleware
app.use(express.static('public'));
app.use(bodyParser.json());

// Function to clear uploads folder
function clearUploadsFolder() {
  const folder = path.join(__dirname, 'uploads');
  fs.readdir(folder, (err, files) => {
    if (err) return console.error('Failed to read upload folder', err);

    for (const file of files) {
      fs.unlink(path.join(folder, file), err => {
        if (err) console.error(`Failed to delete file ${file}:`, err);
      });
    }
  });
}

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// WhatsApp client
let client;
let isClientReady = false;
let currentQR = null;

function createNewClient() {
  console.log('🔄 Initializing WhatsApp client...');
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'session' }),
    puppeteer: { headless: true, args: ['--no-sandbox'] }
  });

  client.on('qr', async (qr) => {
    currentQR = qr;
    console.log('📱 QR Code received');
  });

  client.on('ready', () => {
    isClientReady = true;
    console.log('✅ WhatsApp client is ready');
  });

  client.on('disconnected', async (reason) => {
    console.warn('⚠️ Disconnected:', reason);
    isClientReady = false;
    currentQR = null;
    try { await client.destroy(); } catch {}
    setTimeout(cleanAndRestartClient, 3000);
  });

  client.on('auth_failure', async () => {
    console.warn('❌ Auth failure');
    isClientReady = false;
    currentQR = null;
    try { await client.destroy(); } catch {}
    setTimeout(cleanAndRestartClient, 3000);
  });

  client.on('error', (err) => {
    console.error('💥 Client error:', err);
    isClientReady = false;
  });

  client.initialize();
}

function cleanAndRestartClient() {
  const sessionPath = path.join(__dirname, '.wwebjs_auth', 'session');
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true });
    console.log('🧹 Session folder cleaned');
  }
  createNewClient();
}

// Uncaught exception handler
process.on('uncaughtException', (err) => {
  if (err.message.includes('EBUSY')) {
    console.warn('⚠️ Ignored EBUSY:', err.message);
  } else {
    console.error('💥 Uncaught Exception:', err);
    process.exit(1);
  }
});

// GET: QR Code
app.get('/qr', async (req, res) => {
  if (!currentQR) {
    return res.status(404).send('QR code not available. Please refresh after 5-10 sec.');
  }
  try {
    const qrImage = await qrcode.toDataURL(currentQR);
    res.send(`<img src="${qrImage}" alt="Scan QR" />`);
  } catch {
    res.status(500).send('Failed to generate QR code');
  }
});

// GET: Client status
app.get('/status', (req, res) => {
  res.json({ ready: isClientReady });
});

// GET: Logs
app.get('/logs', (req, res) => {
  try {
    const logs = JSON.parse(fs.readFileSync(LOG_FILE));
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read logs.' });
  }
});

// Route to serve logs as an Excel file
app.get('/download-logs', (req, res) => {
  try {
    // Read logs from the logs.json file
    const logs = JSON.parse(fs.readFileSync(LOG_FILE));

    // Convert the logs to a worksheet
    const ws = xlsx.utils.json_to_sheet(logs);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, "Logs");

    // Set response headers for downloading the Excel file
    res.setHeader('Content-Disposition', 'attachment; filename=logs.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    // Write the Excel file to the response
    const excelFile = xlsx.write(wb, { bookType: 'xlsx', type: 'buffer' });
    res.send(excelFile);
  } catch (err) {
    console.error('Error generating Excel file:', err);
    res.status(500).json({ error: 'Failed to generate Excel file' });
  }
});

// POST: Send WhatsApp Messages
app.post('/send-messages', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'media', maxCount: 1 }
]), async (req, res) => {
  if (!isClientReady) {
    return res.status(503).json({ status: 'error', message: 'WhatsApp client not ready.' });
  }

  // ✅ Overwrite logs: Start fresh
  let logs = [];

  // Create the file if it doesn't exist
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(LOG_FILE, '[]');
    }
  } catch (err) {
    console.error('❌ Error ensuring logs file:', err);
    return res.status(500).json({ status: 'error', message: 'Log file setup failed.' });
  }

  const excelFile = req.files['file']?.[0];
  const mediaFile = req.files['media']?.[0];
  const messageText = req.body.message;

  if (!excelFile) {
    return res.status(400).json({ status: 'error', message: 'Excel file is required.' });
  }

  const workbook = xlsx.readFile(excelFile.path);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(sheet);
  const mediaPath = mediaFile ? mediaFile.path : null;

  const BATCH_SIZE = 25;
  const MESSAGE_DELAY = 3000;
  const BATCH_DELAY = 60000;
  const results = [];

  const cleanPhone = (num) => num.toString().replace(/[^0-9]/g, '');

 // Inside your /send-messages route:

for (let i = 0; i < data.length; i += BATCH_SIZE) {
  const batch = data.slice(i, i + BATCH_SIZE);

  for (const row of batch) {
    const rawNumber = row.Number;
    const phone = cleanPhone(rawNumber);
    const chatId = `${phone}@c.us`;

    try {
      // Check if the phone number is registered on WhatsApp
      const isRegistered = await client.isRegisteredUser(chatId);

      if (!isRegistered) {
        // Log number as not registered on WhatsApp
        results.push(`❌ ${phone} is not on WhatsApp.`);
        logs.push({
          number: phone,
          time: new Date().toISOString(),
          message: messageText,
          status: 'not_registered',
          error_message: 'Number is not registered on WhatsApp'
        });
        continue; // Skip sending the message
      }

      // Proceed if the number is valid
      const randomDelay = MESSAGE_DELAY + Math.floor(Math.random() * 2000);
      await new Promise(resolve => setTimeout(resolve, randomDelay));

      // Send the text message
      await client.sendMessage(chatId, messageText || '');

      // Send media if available
      if (mediaPath && fs.existsSync(mediaPath)) {
        const media = MessageMedia.fromFilePath(mediaPath);
        await client.sendMessage(chatId, media);
      }

      // Log the successful message send
      results.push(`✅ Sent to ${phone}`);
      logs.push({
        number: phone,
        time: new Date().toISOString(),
        message: messageText,
        status: 'sent'
      });
      clearUploadsFolder();

    } catch (err) {
      // Log errors with detailed error messages
      results.push(`❌ Failed to send to ${phone}: ${err.message}`);
      logs.push({
        number: phone,
        time: new Date().toISOString(),
        message: messageText,
        status: 'failed',
        error_message: err.message || 'Unknown error'
      });
    }
  }

  // Delay between batches
  if (i + BATCH_SIZE < data.length) {
    console.log('⏳ Waiting before next batch...');
    await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
  }
}
  // ✅ Write only latest session logs to file (overwrite mode)
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
    console.log('📝 Log file written with new session.');
  } catch (err) {
    console.error('❌ Failed to write logs:', err);
  }

  res.json({ status: 'done', results });
});


// Start server
app.listen(port, () => {
  console.log(`🚀 Server running at http://localhost:${port}`);
  createNewClient();
});
