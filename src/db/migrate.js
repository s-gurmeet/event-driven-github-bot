#!/usr/bin/env node
require('dotenv').config();
const { migrate } = require('./index');

migrate()
  .then(() => {
    console.log('Database migration successful');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
