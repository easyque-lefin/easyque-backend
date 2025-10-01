// routes/users.js
const express = require("express");
const router = express.Router();
const db = require("../db");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

// File upload (profile pictures)
const uploadDir = path.join(__dirname, "../uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) =>
    cb(null, Date.now() + "-" + Math.round(Math.random() * 1e9) + path.extname(file.originalname)),
});
const upload = multer({ storage });

// Middleware to check JWT
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: "Missing token" });
  const token = header.split(" ")[1];
  jwt.verify(token, process.env.JWT_SECRET || "supersecret", (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid token" });
    req.user = decoded;
    next();
  });
}

// ---------------- PROFILE EDIT ----------------
// Postman expects PUT /users/profile/edit
router.put("/profile/edit", auth, async (req, res) => {
  try {
    const { name, phone } = req.body;
    await db.query("UPDATE users SET name=?, phone=? WHERE id=?", [
      name,
      phone,
      req.user.id,
    ]);
    return res.json({ message: "Profile updated" });
  } catch (err) {
    console.error("Profile edit error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------- UPLOAD PROFILE PICTURE ----------------
router.post("/profile/picture", auth, upload.single("file"), async (req, res) => {
  try {
    const filename = `/uploads/${req.file.filename}`;
    await db.query("UPDATE users SET profile_pic=? WHERE id=?", [filename, req.user.id]);
    return res.json({ message: "Profile picture uploaded", url: filename });
  } catch (err) {
    console.error("Profile picture upload error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;


