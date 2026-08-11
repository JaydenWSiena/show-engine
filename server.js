require('dotenv').config(); // Load environment variables
const express = require('express');
const https = require('https'); // Swapped from 'http'
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');

// S3 and Multer-S3 imports
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const multerS3 = require('multer-s3');

const app = express();

// --- HTTPS SSL CERTIFICATE CONFIGURATION ---
const sslOptions = {
	key: fs.readFileSync(
		process.env.SSL_KEY_PATH || path.join(__dirname, 'key.pem')
	),
	cert: fs.readFileSync(
		process.env.SSL_CERT_PATH || path.join(__dirname, 'cert.pem')
	),
};

const server = https.createServer(sslOptions, app);
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

// Configure Multer to save temporarily to a local /tmp folder
const upload = multer({ dest: 'uploads_temp/' });

// Helper function to convert audio using FFmpeg
function convertAudio(inputPath, outputPath) {
	return new Promise((resolve, reject) => {
		ffmpeg(inputPath)
			.audioCodec('pcm_s16le') // 16-bit PCM WAV
			.audioFrequency(44100) // 44.1kHz sample rate
			.audioChannels(2) // Stereo
			.format('wav') // Force WAV container
			.on('end', () => resolve(outputPath))
			.on('error', (err) => reject(err))
			.save(outputPath);
	});
}

app.use(express.json());
app.use(express.static('public'));

// --- IN-MEMORY DATABASE CACHE ---
function loadDBFromDisk() {
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

let dbCache = loadDBFromDisk();

function readDB() {
	return dbCache;
}

function saveDB(db, showId) {
	dbCache = db;

	const tempPath = `${DB_PATH}.tmp`;
	fs.writeFile(tempPath, JSON.stringify(db, null, 2), (writeErr) => {
		if (writeErr) return console.error('Save DB error:', writeErr);
		fs.rename(tempPath, DB_PATH, (renameErr) => {
			if (renameErr) console.error('Save DB rename error:', renameErr);
		});
	});

	if (showId) {
		io.to(showId).to('admin-room').emit('database-updated', db);
	} else {
		io.emit('database-updated', db);
	}
}

// Helper function to construct structured viewer tracks array from database cues
function buildCueTracks(show, cue) {
	if (!cue) return [];
	let tracks = [];

	// 1. Add Instrumental
	if (cue.instrumentalUrl) {
		tracks.push({
			id: 'inst-' + (cue.id || 'main'),
			name: '🎵 Instrumental',
			src: cue.instrumentalUrl,
			avatar: '',
		});
	}

	// 2. Add Character Stems
	const activeCastId = show?.activeCastId || 'cast-main';
	const activeCast = show?.casts?.find((c) => c.id === activeCastId);

	let stems = [];
	if (cue.castStems && cue.castStems[activeCastId]) {
		stems = cue.castStems[activeCastId];
	} else if (cue.castStems) {
		Object.values(cue.castStems).forEach((stemArray) => {
			if (Array.isArray(stemArray)) stems.push(...stemArray);
		});
	}

	stems.forEach((stem, idx) => {
		if (!stem.audioUrl) return;

		const charDef = show?.characters?.find(
			(c) => c.id === stem.characterId
		);
		const memberInfo = activeCast?.members
			? activeCast.members[stem.characterId]
			: null;

		const charName = charDef ? charDef.name : 'Role';
		const actorName = memberInfo?.actor ? ` (${memberInfo.actor})` : '';
		const avatarUrl = memberInfo?.avatarUrl || '';

		tracks.push({
			id: `stem-${stem.characterId || idx}-${idx}`,
			name: `${charName}${actorName}`,
			src: stem.audioUrl,
			avatar: avatarUrl,
		});
	});

	return tracks;
}

// --- REST API ---

app.get('/api/database', (req, res) => res.json(readDB()));

app.post('/api/upload', upload.single('file'), async (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: 'No file uploaded' });
	}

	const tempInputPath = req.file.path;
	const tempOutputPath = path.join(
		'uploads_temp',
		`converted-${Date.now()}.wav`
	);

	try {
		console.log(`⏳ Converting ${req.file.originalname}...`);
		await convertAudio(tempInputPath, tempOutputPath);

		const { size: fileSize } = fs.statSync(tempOutputPath);
		const fileStream = fs.createReadStream(tempOutputPath);
		const fileKey = `uploads/${Date.now()}-${req.file.originalname.replace(
			/\s+/g,
			'_'
		)}`;

		const uploadParams = {
			Bucket: process.env.DO_SPACES_BUCKET,
			Key: fileKey,
			Body: fileStream,
			ContentLength: fileSize,
			ACL: 'public-read',
			ContentType: 'audio/wav',
		};

		await s3Client.send(new PutObjectCommand(uploadParams));

		const fileUrl = `https://${process.env.DO_SPACES_BUCKET}.${process.env.DO_SPACES_REGION}.digitaloceanspaces.com/${fileKey}`;

		console.log(`✅ Upload successful: ${fileUrl}`);
		res.json({ url: fileUrl });
	} catch (error) {
		console.error('❌ Conversion or Upload Failed:', error);
		res.status(500).json({
			error: 'Failed to convert or upload audio file.',
		});
	} finally {
		if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
		if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
	}
});

// SHOWS
app.post('/api/shows', (req, res) => {
	const { title } = req.body;
	if (!title) return res.status(400).json({ error: 'Title required' });
	const db = readDB();
	const newShow = {
		id: 'show-' + Date.now(),
		title,
		activeCastId: 'cast-main',
		activeCueListId: 'cuelist-main',
		characters: [],
		casts: [{ id: 'cast-main', name: 'Main Cast', members: {} }],
		cueLists: [{ id: 'cuelist-main', name: 'Main Show Cues', cues: [] }],
	};
	db.shows.push(newShow);
	saveDB(db);
	res.status(201).json(newShow);
});

app.delete('/api/shows/:showId', (req, res) => {
	const db = readDB();
	db.shows = db.shows.filter((s) => s.id !== req.params.showId);
	saveDB(db, req.params.showId);
	res.json({ success: true });
});

// CHARACTERS
app.post('/api/shows/:showId/characters', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	const char = { id: 'char-' + Date.now(), name: req.body.name };
	show.characters.push(char);
	saveDB(db, req.params.showId);
	res.status(201).json(char);
});

app.put('/api/shows/:showId/characters/:charId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const char = show?.characters.find((c) => c.id === req.params.charId);
	if (!char) return res.status(404).json({ error: 'Character not found' });

	char.name = req.body.name;
	saveDB(db, req.params.showId);
	res.json(char);
});

app.delete('/api/shows/:showId/characters/:charId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	const { charId } = req.params;
	show.characters = show.characters.filter((c) => c.id !== charId);

	show.casts.forEach((c) => {
		if (c.members) delete c.members[charId];
	});
	show.cueLists.forEach((l) =>
		l.cues.forEach((cue) => {
			Object.keys(cue.castStems || {}).forEach((castId) => {
				cue.castStems[castId] = cue.castStems[castId].filter(
					(s) => s.characterId !== charId
				);
			});
		})
	);

	saveDB(db, req.params.showId);
	res.json({ success: true });
});

// CAST ROSTER
app.put('/api/shows/:showId/casts/:castId/roster/:charId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const cast = show?.casts.find((c) => c.id === req.params.castId);
	if (!cast) return res.status(404).json({ error: 'Cast not found' });

	if (!cast.members) cast.members = {};
	const { actor, avatarUrl } = req.body;
	cast.members[req.params.charId] = {
		actor:
			actor !== undefined
				? actor
				: cast.members[req.params.charId]?.actor || '',
		avatarUrl:
			avatarUrl !== undefined
				? avatarUrl
				: cast.members[req.params.charId]?.avatarUrl || '',
	};

	saveDB(db, req.params.showId);
	res.json(cast.members[req.params.charId]);
});

// CASTS
app.post('/api/shows/:showId/casts', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	const cast = { id: 'cast-' + Date.now(), name: req.body.name, members: {} };
	show.casts.push(cast);
	saveDB(db, req.params.showId);
	res.status(201).json(cast);
});

app.put('/api/shows/:showId/casts/:castId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const cast = show?.casts.find((c) => c.id === req.params.castId);
	if (!cast) return res.status(404).json({ error: 'Cast not found' });

	cast.name = req.body.name;
	saveDB(db, req.params.showId);
	res.json(cast);
});

app.delete('/api/shows/:showId/casts/:castId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show || show.casts.length <= 1)
		return res.status(400).json({ error: 'Cannot delete last cast' });

	show.casts = show.casts.filter((c) => c.id !== req.params.castId);
	saveDB(db, req.params.showId);
	res.json({ success: true });
});

// CUE LISTS
app.post('/api/shows/:showId/cuelists', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	const list = { id: 'cuelist-' + Date.now(), name: req.body.name, cues: [] };
	show.cueLists.push(list);
	saveDB(db, req.params.showId);
	res.status(201).json(list);
});

app.put('/api/shows/:showId/cuelists/:listId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const list = show?.cueLists.find((l) => l.id === req.params.listId);
	if (!list) return res.status(404).json({ error: 'Cue List not found' });

	list.name = req.body.name;
	saveDB(db, req.params.showId);
	res.json(list);
});

app.delete('/api/shows/:showId/cuelists/:listId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show || show.cueLists.length <= 1)
		return res.status(400).json({ error: 'Cannot delete last cue list' });

	show.cueLists = show.cueLists.filter((l) => l.id !== req.params.listId);
	saveDB(db, req.params.showId);
	res.json({ success: true });
});

// CUES & STEMS
app.post('/api/shows/:showId/cuelists/:listId/cues', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const list = show?.cueLists.find((l) => l.id === req.params.listId);
	if (!list) return res.status(404).json({ error: 'Cue list not found' });

	const cue = {
		id: 'cue-' + Date.now(),
		num: req.body.num,
		name: req.body.name,
		instrumentalUrl: '',
		castStems: {},
	};
	list.cues.push(cue);
	saveDB(db, req.params.showId);
	res.status(201).json(cue);
});

app.put('/api/shows/:showId/cuelists/:listId/cues/:cueId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	const list = show?.cueLists.find((l) => l.id === req.params.listId);
	const cue = list?.cues.find((c) => c.id === req.params.cueId);
	if (!cue) return res.status(404).json({ error: 'Cue not found' });

	Object.assign(cue, req.body);
	saveDB(db, req.params.showId);
	res.json(cue);
});

// NEW: DELETE CUE ENDPOINT
app.delete('/api/shows/:showId/cuelists/:listId/cues/:cueId', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	const list = show.cueLists.find((l) => l.id === req.params.listId);
	if (!list) return res.status(404).json({ error: 'Cue list not found' });

	const initialCount = list.cues.length;
	list.cues = list.cues.filter((c) => c.id !== req.params.cueId);

	if (list.cues.length === initialCount) {
		return res.status(404).json({ error: 'Cue not found' });
	}

	saveDB(db, req.params.showId);
	res.json({ success: true });
});

app.post(
	'/api/shows/:showId/cuelists/:listId/cues/:cueId/stems',
	(req, res) => {
		const { castId, characterId, audioUrl } = req.body;
		const db = readDB();
		const show = db.shows.find((s) => s.id === req.params.showId);
		const list = show?.cueLists.find((l) => l.id === req.params.listId);
		const cue = list?.cues.find((c) => c.id === req.params.cueId);

		if (!cue) return res.status(404).json({ error: 'Cue not found' });
		if (!cue.castStems) cue.castStems = {};
		if (!cue.castStems[castId]) cue.castStems[castId] = [];

		cue.castStems[castId] = cue.castStems[castId].filter(
			(s) => s.characterId !== characterId
		);
		cue.castStems[castId].push({ characterId, audioUrl });

		saveDB(db, req.params.showId);
		res.status(201).json(cue);
	}
);

app.delete(
	'/api/shows/:showId/cuelists/:listId/cues/:cueId/stems/:castId/:index',
	(req, res) => {
		const { castId, index } = req.params;
		const db = readDB();
		const show = db.shows.find((s) => s.id === req.params.showId);
		const list = show?.cueLists.find((l) => l.id === req.params.listId);
		const cue = list?.cues.find((c) => c.id === req.params.cueId);

		if (cue && cue.castStems && cue.castStems[castId]) {
			cue.castStems[castId].splice(parseInt(index, 10), 1);
			saveDB(db, req.params.showId);
		}
		res.json({ success: true });
	}
);

app.put('/api/shows/:showId/active', (req, res) => {
	const db = readDB();
	const show = db.shows.find((s) => s.id === req.params.showId);
	if (!show) return res.status(404).json({ error: 'Show not found' });

	if (req.body.activeCastId) show.activeCastId = req.body.activeCastId;
	if (req.body.activeCueListId)
		show.activeCueListId = req.body.activeCueListId;

	saveDB(db, req.params.showId);
	res.json(show);
});

// BATCH IMPORT BANDLAB STEMS & INSTRUMENTAL
app.post(
	'/api/shows/:showId/cuelists/:listId/cues/:cueId/batch-import',
	(req, res) => {
		const { castId, instrumentalUrl, stems } = req.body;
		const db = readDB();
		const show = db.shows.find((s) => s.id === req.params.showId);
		const list = show?.cueLists.find((l) => l.id === req.params.listId);
		const cue = list?.cues.find((c) => c.id === req.params.cueId);

		if (!cue) return res.status(404).json({ error: 'Cue not found' });

		// Update instrumental if a new one was uploaded
		if (instrumentalUrl) {
			cue.instrumentalUrl = instrumentalUrl;
		}

		// Set stems specifically for this cast
		if (castId && Array.isArray(stems)) {
			if (!cue.castStems) cue.castStems = {};

			// Clean overwrite for this cast's stems
			cue.castStems[castId] = stems.map((s) => ({
				characterId: s.characterId,
				audioUrl: s.audioUrl,
			}));
		}

		saveDB(db, req.params.showId);
		res.json(cue);
	}
);

// --- SOCKET.IO SHOW ENGINE WITH SEEK & SYNC ---
const shows = {};

io.on('connection', (socket) => {
	socket.on('register-admin', () => {
		socket.join('admin-room');
	});

	socket.on('clock-sync', (data) => {
		socket.emit('clock-sync-response', {
			clientSendTime: data.clientSendTime,
			serverTime: Date.now(),
		});
	});

	const sendActiveCueToSocket = (targetSocket, showId) => {
		if (
			shows[showId] &&
			shows[showId].activeCue &&
			shows[showId].startTime
		) {
			const currentSeekTime =
				(Date.now() - shows[showId].startTime) / 1000;
			targetSocket.emit('cue-triggered', {
				activeCue: shows[showId].activeCue,
				currentSeekTime: Math.max(0, currentSeekTime),
				serverTimestamp: Date.now(),
			});
		}
	};

	socket.on('join-show', ({ showId }) => {
		if (!showId) return;
		socket.join(showId);

		if (!shows[showId]) {
			shows[showId] = { activeCue: null, startTime: null };
		} else {
			sendActiveCueToSocket(socket, showId);
		}
	});

	socket.on('request-current-state', ({ showId }) => {
		const targetShow = showId || 'main-show';
		sendActiveCueToSocket(socket, targetShow);
	});

	// Trigger a cue for all clients
	socket.on('trigger-cue', (data) => {
		const showId = data?.showId || 'main-show';
		const rawCue = data?.cue || data;
		const db = readDB();
		const show = db.shows.find((s) => s.id === showId);

		let fullCue = rawCue;
		let tracks = [];

		if (show && rawCue) {
			show.cueLists?.forEach((list) => {
				const found = list.cues?.find((c) => c.id === rawCue.id);
				if (found) {
					fullCue = found;
					show.activeCueListId = list.id;
				}
			});

			show.activeCueId = fullCue.id;
			saveDB(db, showId);

			tracks = buildCueTracks(show, fullCue);
		} else if (rawCue && Array.isArray(rawCue.tracks)) {
			tracks = rawCue.tracks;
		}

		const payload = {
			id: fullCue?.id,
			name: fullCue?.name || 'Cue',
			tracks,
		};

		shows[showId] = {
			activeCue: payload,
			startTime: Date.now(),
		};

		io.to(showId).emit('cue-triggered', {
			activeCue: payload,
			currentSeekTime: 0,
			serverTimestamp: Date.now(),
		});
		io.to(showId).emit('cue-started', { showId });
	});

	// SEEK / JUMP TO POSITION IN CUE
	socket.on('seek-cue', (data) => {
		const showId = data?.showId || 'main-show';
		const position = data?.position || 0;

		if (shows[showId] && shows[showId].activeCue) {
			shows[showId].startTime = Date.now() - position * 1000;
		}

		io.to(showId).emit('cue-seeked', { showId, position });
		io.to(showId).emit('cue-position-sync', {
			showId,
			currentTime: position,
		});
	});

	socket.on('cue-position-sync', (data) => {
		const showId = data?.showId || 'main-show';
		socket.to(showId).emit('cue-position-sync', data);
	});

	socket.on('stop-show', (data) => {
		const target = data?.showId || 'main-show';
		if (shows[target]) {
			shows[target].activeCue = null;
			shows[target].startTime = null;
		}

		const db = readDB();
		const show = db.shows.find((s) => s.id === target);
		if (show) {
			show.activeCueId = null;
			saveDB(db, target);
		}

		io.to(target).emit('cue-stopped', { showId: target });
		io.to(target).emit('show-stopped', { showId: target });
	});
});

const PORT = process.env.PORT || 443;
server.listen(PORT, '0.0.0.0', () =>
	console.log(`🔒 Secure HTTPS Server running on https://localhost:${PORT}`)
);
