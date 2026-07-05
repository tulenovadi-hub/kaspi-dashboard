const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const router = express.Router();

const VALID_ROLES = ['admin', 'manager', 'marketer'];

router.get('/', async (req, res) => {
  try {
    const result = await pool.query(`SELECT id, username, role, created_at FROM users ORDER BY created_at ASC`);
    res.json({ users: result.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось получить список пользователей' });
  }
});

router.post('/', async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) {
    return res.status(400).json({ error: 'Заполните логин, пароль и роль' });
  }
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }
  if (password.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)
       RETURNING id, username, role, created_at`,
      [username.trim(), passwordHash, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(400).json({ error: 'Пользователь с таким логином уже существует' });
    }
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать пользователя' });
  }
});

// Смена пароля и/или роли существующего пользователя
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { password, role } = req.body;

  if (role && !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Некорректная роль' });
  }
  if (password && password.length < 4) {
    return res.status(400).json({ error: 'Пароль слишком короткий (минимум 4 символа)' });
  }
  if (!password && !role) {
    return res.status(400).json({ error: 'Нечего обновлять' });
  }

  try {
    if (password) {
      const passwordHash = await bcrypt.hash(password, 10);
      await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, id]);
    }
    if (role) {
      await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [role, id]);
    }
    const result = await pool.query(`SELECT id, username, role, created_at FROM users WHERE id = $1`, [id]);
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    res.json({ user: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось обновить пользователя' });
  }
});

router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: 'Нельзя удалить самого себя' });
  }

  try {
    const adminsCount = await pool.query(`SELECT COUNT(*) AS count FROM users WHERE role = 'admin'`);
    const target = await pool.query(`SELECT role FROM users WHERE id = $1`, [id]);
    if (target.rowCount === 0) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    if (target.rows[0].role === 'admin' && Number(adminsCount.rows[0].count) <= 1) {
      return res.status(400).json({ error: 'Нельзя удалить последнего администратора' });
    }

    await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось удалить пользователя' });
  }
});

module.exports = router;
