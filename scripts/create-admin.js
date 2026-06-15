#!/usr/bin/env node
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

async function createAdmin() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.log("Usage: node create-admin.js <name> <email> <password>");
    console.log("Example: node create-admin.js 'Loretta Bates' loretta@example.com password123");
    process.exit(1);
  }

  const [name, email, password] = args;

  if (password.length < 8) {
    console.error("Error: Password must be at least 8 characters");
    process.exit(1);
  }

  try {
    const passwordHash = await bcrypt.hash(password, 10);

    const { rows } = await pool.query(
      "INSERT INTO admin_users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email",
      [name, email.toLowerCase(), passwordHash]
    );

    console.log("✓ Admin user created successfully!");
    console.log(`  ID: ${rows[0].id}`);
    console.log(`  Name: ${rows[0].name}`);
    console.log(`  Email: ${rows[0].email}`);

    process.exit(0);
  } catch (err) {
    if (err.code === "23505") {
      console.error(`Error: Email '${email}' is already registered`);
    } else {
      console.error("Error:", err.message);
    }
    process.exit(1);
  }
}

createAdmin();
