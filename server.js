require('dotenv').config(); // Load environment variables
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Add S3 and Multer-S3 imports
const { S3Client } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_PATH = path.join(__dirname, 'database.json');

// --- DIGITALOCEAN SPACES CONFIGURATION ---
const s3Client = new S3Client({
	endpoint: `https://${process.env.DO_SPACES_REGION}.digitaloceanspaces.com`,
	region: process.env.DO_SPACES_REGION || 'nyc3',
	credentials: {
		accessKeyId: process.env.DO_SPACES_KEY,
		secretAccessKey: process.env.DO_SPACES_SECRET,
	},
});

const upload = multer({
	storage: multerS3({
		s3: s3Client,
		bucket: process.env.DO_SPACES_BUCKET,
		acl: 'public-read', // Makes uploaded audio/images publicly readable
		key: (req, file, cb) => {
			const ext = path.extname(file.originalname);
			cb(null, `uploads/${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
		},
	}),
});

app.use(express.json());
app.use(express.static('public'));

function readDB() {
	try {
		if (!fs.existsSync(DB_PATH)) {
			const initialData = { shows: [] };
			fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
			return initialData;
		}
		return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
	} catch (err) {
		console.error('Read DB error:', err);
		return { shows: [] };
	}
}

function saveDB(db) {
	try {
		const tempPath = `${DB_PATH}.tmp`;
		fs.writeFileSync(tempPath, JSON.stringify(db, null, 2));
		fs.renameSync(tempPath, DB_PATH);
		io.emit('database-updated', db);
	} catch (err) {
		console.error('Save DB error:', err);
	}
}

// --- REST API ---

app.get('/api/database', (req, res) => res.json(readDB()));

// UPDATED: Multer-S3 attaches the full public Spaces URL to req.file.location
app.post('/api/upload', upload.single('file'), (req, res) => {
	if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
	res.json({ url: req.file.location });
});

// ... (keep the rest of your server.js API endpoints and Socket.IO handlers unchanged)
