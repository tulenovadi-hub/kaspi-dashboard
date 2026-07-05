const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { pool } = require('../db');

const router = express.Router();

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Вход — публичный роут, не требует токена
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Введите логин и пароль' });
  }

  try {
    const result = await pool.query(`SELECT id, username, password_hash, role FROM users WHERE username = $1`, [username]);
    if (result.rowCount === 0) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const user = result.rows[0];
    const passwordOk = await bcrypt.compare(password, user.password_hash);
    if (!passwordOk) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const token = generateToken();
    await pool.query(`INSERT INTO sessions (token, user_id) VALUES ($1, $2)`, [token, user.id]);

    res.json({ token, username: user.username, role: user.role });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось войти' });
  }
});

// Выход — требует токен (проверяется общим auth middleware до этого роута)
router.post('/logout', async (req, res) => {
  const token = req.header('X-Session-Token');
  try {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось выйти' });
  }
});

// Проверка текущей сессии — используется при загрузке сайта, чтобы понять,
// действителен ли ещё сохранённый токен, и какая у пользователя роль.
router.get('/me', async (req, res) => {
  res.json({ username: req.user.username, role: req.user.role });
});

module.exports = router;
