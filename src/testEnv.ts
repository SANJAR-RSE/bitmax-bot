// Loaded before every test file (see the "test" scripts in package.json). Tests must never read
// .env: it holds the production bot token, database and payment keys, and one forgotten mock
// would message real admins or call the real payment provider.
process.env.NODE_ENV = 'test';
