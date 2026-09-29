require('dotenv').config({ quiet: true });
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const { pool, query, getOne, initSchema } = require('./db');
const MySQLSessionStore = require('./session-store');
const { upload, stripMetadata, MAX_FILE_SIZE } = require('./attachments');
const email = require('./email');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new MySQLSessionStore(pool),
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 12, // 12 hours
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));

// ---------- helpers ----------
async function currentUser(req) {
  if (!req.session.userId) return null;
  return getOne(`SELECT * FROM users WHERE id = ? AND active = 1`, [req.session.userId]);
}

async function requireAuth(req, res, next) {
  try {
    const user = await currentUser(req);
    if (!user) return res.redirect('/login');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).send('Not authorized to view this page.');
    next();
  };
}

function fmtNumber(n) { return 'RFI-' + String(n).padStart(3, '0'); }
app.locals.fmtNumber = fmtNumber;

async function getOwnerEmails() {
  const rows = await query(
    `SELECT email FROM users WHERE role = 'owner' AND active = 1 AND email IS NOT NULL AND email != ''`
  );
  return rows.map(r => r.email);
}

function randomPassword() {
  return Math.random().toString(36).slice(2, 6) + '-' + Math.random().toString(36).slice(2, 6);
}

// Wraps multer's single-file upload so oversize/wrong-type errors become a friendly
// redirect instead of a raw error page. Sets req.uploadError so the route decides how to show it.
function handleUpload(fieldName) {
  const mw = upload.single(fieldName);
  return (req, res, next) => {
    mw(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          req.uploadError = `That file is too large — the limit is ${MAX_FILE_SIZE / (1024 * 1024)}MB.`;
        } else {
          req.uploadError = err.message || 'That file could not be uploaded.';
        }
      }
      next();
    });
  };
}

// ---------- shared log (used inside gc/owner/consultant dashboards) ----------
// Note: question_attachment_data / answer_attachment_data (the BLOBs) are deliberately
// excluded here — we only need to know a filename exists to show a link; the actual
// bytes are fetched separately by the /attachment route when someone clicks it.
async function getLog() {
  return query(`
    SELECT r.id, r.id AS number, r.subject, r.spec_ref, r.question, r.status, r.answer,
      r.question_attachment_name, r.answer_attachment_name,
      c.display_label AS consultant_label
    FROM rfis r
    LEFT JOIN users c ON c.id = r.assigned_consultant_id
    ORDER BY r.id ASC
  `);
}

// ---------- auth routes ----------
app.get('/', requireAuth, (req, res) => {
  if (req.user.role === 'owner') return res.redirect('/owner');
  if (req.user.role === 'consultant') return res.redirect('/consultant');
  return res.redirect('/gc');
});

app.get('/login', async (req, res) => {
  if (await currentUser(req)) return res.redirect('/');
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const normalized = (username || '').trim().toLowerCase();
  const user = await getOne(`SELECT * FROM users WHERE username = ? AND active = 1`, [normalized]);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.render('login', { error: 'Incorrect username or password.' });
  }
  req.session.userId = user.id;
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------- change password / email (any logged-in role) ----------
app.get('/account/change-password', requireAuth, (req, res) => {
  res.render('change-password', { user: req.user, error: null, success: null });
});

app.post('/account/email', requireAuth, async (req, res) => {
  const newEmail = (req.body.email || '').trim().toLowerCase();
  await query(`UPDATE users SET email = ? WHERE id = ?`, [newEmail || null, req.user.id]);
  const refreshedUser = await getOne(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
  res.render('change-password', { user: refreshedUser, error: null, success: 'Notification email updated.' });
});

app.post('/account/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!bcrypt.compareSync(current_password || '', req.user.password_hash)) {
    return res.render('change-password', { user: req.user, error: 'Current password is incorrect.', success: null });
  }
  if (!new_password || new_password.length < 8) {
    return res.render('change-password', { user: req.user, error: 'New password must be at least 8 characters.', success: null });
  }
  if (new_password !== confirm_password) {
    return res.render('change-password', { user: req.user, error: 'New password and confirmation do not match.', success: null });
  }

  const hash = bcrypt.hashSync(new_password, 10);
  await query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, req.user.id]);
  res.render('change-password', { user: req.user, error: null, success: 'Password updated.' });
});

// ---------- GC routes ----------
app.get('/gc', requireAuth, requireRole('gc'), async (req, res) => {
  res.render('gc-dashboard', { user: req.user, log: await getLog(), tab: req.query.tab || 'log', error: null });
});

app.post('/gc/rfi', requireAuth, requireRole('gc'), handleUpload('attachment'), async (req, res) => {
  const { subject, spec_ref, question } = req.body;
  if (req.uploadError) {
    return res.render('gc-dashboard', { user: req.user, log: await getLog(), tab: 'submit', error: req.uploadError });
  }
  if (!subject || !subject.trim() || !question || !question.trim()) {
    return res.render('gc-dashboard', { user: req.user, log: await getLog(), tab: 'submit', error: 'Subject and question are both required.' });
  }

  let attachmentBuffer = null;
  if (req.file) {
    attachmentBuffer = await stripMetadata(req.file.buffer, req.file.mimetype);
  }

  const result = await query(`
    INSERT INTO rfis (gc_user_id, subject, spec_ref, question, status,
      question_attachment_name, question_attachment_mime, question_attachment_data)
    VALUES (?, ?, ?, ?, 'submitted', ?, ?, ?)
  `, [
    req.user.id, subject.trim(), (spec_ref || '').trim(), question.trim(),
    req.file ? req.file.originalname : null,
    req.file ? req.file.mimetype : null,
    attachmentBuffer
  ]);

  email.notifyNewRfiSubmitted({ ownerEmails: await getOwnerEmails(), rfiNumber: result.insertId, subject: subject.trim() });

  res.redirect('/gc?tab=log');
});

// ---------- Consultant routes ----------
app.get('/consultant', requireAuth, requireRole('consultant'), async (req, res) => {
  const assigned = await query(`
    SELECT id, id AS number, subject, spec_ref, question, status, question_attachment_name
    FROM rfis WHERE assigned_consultant_id = ? AND status = 'assigned' ORDER BY id ASC
  `, [req.user.id]);
  const pendingApproval = await query(`
    SELECT id, id AS number, subject, spec_ref, question, answer, status,
      question_attachment_name, answer_attachment_name
    FROM rfis WHERE assigned_consultant_id = ? AND status = 'answered' ORDER BY id ASC
  `, [req.user.id]);
  res.render('consultant-dashboard', {
    user: req.user, assigned, pendingApproval, log: await getLog(), tab: req.query.tab || 'answer'
  });
});

app.post('/consultant/answer/:id', requireAuth, requireRole('consultant'), handleUpload('attachment'), async (req, res) => {
  const rfi = await getOne(`SELECT * FROM rfis WHERE id = ? AND assigned_consultant_id = ?`, [req.params.id, req.user.id]);
  if (!rfi) return res.status(404).send('RFI not found.');
  if (req.uploadError) {
    return res.redirect('/consultant?tab=answer');
  }
  const { answer } = req.body;
  if (!answer || !answer.trim()) {
    return res.redirect('/consultant?tab=answer');
  }

  let attachmentBuffer = null;
  if (req.file) {
    attachmentBuffer = await stripMetadata(req.file.buffer, req.file.mimetype);
  }

  await query(`
    UPDATE rfis SET answer = ?, status = 'answered', answered_at = NOW(),
      answer_attachment_name = ?, answer_attachment_mime = ?, answer_attachment_data = ?
    WHERE id = ?
  `, [
    answer.trim(),
    req.file ? req.file.originalname : null,
    req.file ? req.file.mimetype : null,
    attachmentBuffer,
    rfi.id
  ]);

  email.notifyAnswerAwaitingApproval({ ownerEmails: await getOwnerEmails(), rfiNumber: rfi.id, subject: rfi.subject });

  res.redirect('/consultant?tab=answer');
});

// ---------- Owner routes ----------
app.get('/owner', requireAuth, requireRole('owner'), async (req, res) => {
  const unassigned = await query(`
    SELECT id, id AS number, gc_user_id, subject, spec_ref, question, status, question_attachment_name
    FROM rfis WHERE status = 'submitted' ORDER BY id ASC
  `);
  const awaitingApproval = await query(`
    SELECT r.id, r.id AS number, r.gc_user_id, r.subject, r.spec_ref, r.question, r.answer, r.status,
      r.question_attachment_name, r.answer_attachment_name,
      c.display_label AS consultant_label
    FROM rfis r
    LEFT JOIN users c ON c.id = r.assigned_consultant_id
    WHERE r.status = 'answered' ORDER BY r.id ASC
  `);
  const all = await query(`
    SELECT r.id, r.id AS number, r.subject, r.spec_ref, r.question, r.answer, r.status, r.answered_by_owner,
      r.question_attachment_name, r.answer_attachment_name,
      g.display_label AS gc_label, c.display_label AS consultant_label
    FROM rfis r
    JOIN users g ON g.id = r.gc_user_id
    LEFT JOIN users c ON c.id = r.assigned_consultant_id
    ORDER BY r.id DESC
  `);
  const consultants = await query(`SELECT * FROM users WHERE role = 'consultant' AND active = 1 ORDER BY display_label`);
  const users = await query(`SELECT * FROM users WHERE role != 'owner' ORDER BY role, display_label`);

  res.render('owner-dashboard', {
    user: req.user, tab: req.query.tab || 'unassigned',
    unassigned, assigned: [], awaitingApproval, all, consultants, users,
    log: await getLog(), justCreated: req.query.created || null, notice: req.query.notice || null
  });
});

app.post('/owner/assign/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { consultant_id } = req.body;
  const consultant = await getOne(`SELECT * FROM users WHERE id = ? AND role = 'consultant'`, [consultant_id]);
  if (!consultant) return res.redirect('/owner?tab=unassigned');
  const rfi = await getOne(`SELECT * FROM rfis WHERE id = ? AND status = 'submitted'`, [req.params.id]);
  await query(`
    UPDATE rfis SET status = 'assigned', assigned_consultant_id = ?, assigned_at = NOW()
    WHERE id = ? AND status = 'submitted'
  `, [consultant.id, req.params.id]);
  if (rfi) {
    email.notifyRfiAssigned({ consultantEmail: consultant.email, rfiNumber: rfi.id, subject: rfi.subject });
  }
  res.redirect('/owner?tab=unassigned');
});

app.post('/owner/answer-directly/:id', requireAuth, requireRole('owner'), handleUpload('attachment'), async (req, res) => {
  const { answer } = req.body;
  const rfi = await getOne(`SELECT * FROM rfis WHERE id = ? AND status = 'submitted'`, [req.params.id]);
  if (!rfi || req.uploadError || !answer || !answer.trim()) {
    return res.redirect('/owner?tab=unassigned');
  }

  let attachmentBuffer = null;
  if (req.file) {
    attachmentBuffer = await stripMetadata(req.file.buffer, req.file.mimetype);
  }

  await query(`
    UPDATE rfis SET status = 'published', answer = ?, answered_by_owner = 1,
      answered_at = NOW(), published_at = NOW(),
      answer_attachment_name = ?, answer_attachment_mime = ?, answer_attachment_data = ?
    WHERE id = ?
  `, [
    answer.trim(),
    req.file ? req.file.originalname : null,
    req.file ? req.file.mimetype : null,
    attachmentBuffer,
    rfi.id
  ]);
  res.redirect('/owner?tab=unassigned');
});

app.post('/owner/publish/:id', requireAuth, requireRole('owner'), async (req, res) => {
  const { answer } = req.body; // owner can edit the answer before publishing
  const rfi = await getOne(`SELECT * FROM rfis WHERE id = ? AND status = 'answered'`, [req.params.id]);
  if (!rfi) return res.redirect('/owner?tab=approve');
  const finalAnswer = (answer && answer.trim()) ? answer.trim() : rfi.answer;
  await query(`UPDATE rfis SET answer = ?, status = 'published', published_at = NOW() WHERE id = ?`, [finalAnswer, rfi.id]);
  res.redirect('/owner?tab=approve');
});

// ---- user management ----
app.post('/owner/users', requireAuth, requireRole('owner'), async (req, res) => {
  const { role, username, display_label, discipline, email: userEmail } = req.body;
  if (!['gc', 'consultant'].includes(role) || !username || !display_label) {
    return res.redirect('/owner?tab=users');
  }
  const normalizedUsername = username.trim().toLowerCase();
  const existing = await getOne(`SELECT id FROM users WHERE username = ?`, [normalizedUsername]);
  if (existing) {
    return res.redirect('/owner?tab=users&notice=' + encodeURIComponent('That username is already taken.'));
  }
  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 10);
  await query(`
    INSERT INTO users (username, password_hash, role, display_label, discipline, email)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    normalizedUsername, hash, role, display_label.trim(),
    role === 'consultant' ? (discipline || '').trim() : null,
    (userEmail || '').trim().toLowerCase() || null
  ]);
  res.redirect('/owner?tab=users&created=' + encodeURIComponent(`${normalizedUsername} / ${password}`));
});

app.post('/owner/users/:id/reset-password', requireAuth, requireRole('owner'), async (req, res) => {
  const password = randomPassword();
  const hash = bcrypt.hashSync(password, 10);
  const target = await getOne(`SELECT * FROM users WHERE id = ? AND role != 'owner'`, [req.params.id]);
  if (!target) return res.redirect('/owner?tab=users');
  await query(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, target.id]);
  res.redirect('/owner?tab=users&created=' + encodeURIComponent(`${target.username} / ${password}`));
});

app.post('/owner/users/:id/deactivate', requireAuth, requireRole('owner'), async (req, res) => {
  await query(`UPDATE users SET active = 0 WHERE id = ? AND role != 'owner'`, [req.params.id]);
  res.redirect('/owner?tab=users');
});

app.post('/owner/users/:id/reactivate', requireAuth, requireRole('owner'), async (req, res) => {
  await query(`UPDATE users SET active = 1 WHERE id = ? AND role != 'owner'`, [req.params.id]);
  res.redirect('/owner?tab=users');
});

// ---------- attachments ----------
// Question attachments are visible as soon as submitted (same rule as the question text).
// Answer attachments are only servable to GCs once the RFI is published (same rule as the
// answer text) — the owner and the assigned consultant can preview it beforehand.
app.get('/attachment/:rfiId/:type', requireAuth, async (req, res) => {
  const { rfiId, type } = req.params;
  if (!['question', 'answer'].includes(type)) return res.status(404).send('Not found.');

  const rfi = await getOne(`SELECT * FROM rfis WHERE id = ?`, [rfiId]);
  if (!rfi) return res.status(404).send('Not found.');

  const data = type === 'question' ? rfi.question_attachment_data : rfi.answer_attachment_data;
  const originalName = type === 'question' ? rfi.question_attachment_name : rfi.answer_attachment_name;
  const mime = type === 'question' ? rfi.question_attachment_mime : rfi.answer_attachment_mime;
  if (!data) return res.status(404).send('No attachment on this RFI.');

  if (type === 'answer' && rfi.status !== 'published' && req.user.role === 'gc') {
    return res.status(403).send('This answer has not been published yet.');
  }

  res.setHeader('Content-Type', mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(originalName || 'attachment').replace(/"/g, '')}"`);
  res.send(data);
});

// ---------- TEMPORARY maintenance route ----------
// One-time owner-password reset, used only because the host's database import/export
// tooling was unreliable. Gated behind a random token set as an env var so it can't be
// triggered by anyone who doesn't already have access to this app's secrets.
// Remove this route once it's done its job.
app.get('/maintenance/reset-owner-password', async (req, res) => {
  const token = process.env.MAINTENANCE_TOKEN;
  if (!token || req.query.token !== token) {
    return res.status(404).send('Not found.');
  }
  const newPassword = req.query.password;
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).send('Provide ?password=... (8+ characters) in the URL alongside the token.');
  }
  const hash = bcrypt.hashSync(newPassword, 10);
  const result = await query(`UPDATE users SET password_hash = ? WHERE role = 'owner'`, [hash]);
  res.send(`Owner password updated. Rows affected: ${result.affectedRows}. You can log in now with the new password. Please remove this route from the app afterward.`);
});

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`RFI tracker running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  });
