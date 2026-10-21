'use strict'

const admin = require('firebase-admin')
if (admin.apps.length === 0) admin.initializeApp()

// Load only the extracted callables; the production index initializes Gemini and dotenv.
module.exports = {
  ...require('../../lib/pocketImports.js'),
  ...require('../../lib/settlements.js')
}
