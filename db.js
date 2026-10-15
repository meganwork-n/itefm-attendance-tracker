const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data.json");
const USE_DB = !!process.env.DATABASE_URL;

let pool = null;
if (USE_DB) {
  const { Pool } = require("pg");
  const url = process.env.DATABASE_URL;
  const local = /@localhost|@127\.0\.0\.1/.test(url);
  pool = new Pool({
    connectionString: url,
    ssl: local ? false : { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000
  });
}

let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function init(seed) {
  if (!USE_DB) return;
  await pool.query("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const r = await pool.query("SELECT 1 FROM kv WHERE key = 'state'");
  if (r.rowCount === 0) {
    await pool.query("INSERT INTO kv (key, value) VALUES ('state', $1)", [JSON.stringify(seed)]);
  }
}

function read() {
  if (!USE_DB) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    } catch {
      return null;
    }
  }
  return pool.query("SELECT value FROM kv WHERE key = 'state'").then((r) => (r.rowCount ? JSON.parse(r.rows[0].value) : null));
}

function write(state) {
  if (!USE_DB) {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
    return Promise.resolve();
  }
  return pool.query(
    "INSERT INTO kv (key, value) VALUES ('state', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify(state)]
  );
}

function normalize(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    return {
      members: [],
      entries: raw.map((e) => ({ ...e, memberId: "legacy-" + e.name })),
      holidays: []
    };
  }
  return { members: raw.members || [], entries: raw.entries || [], holidays: raw.holidays || [] };
}

function load() {
  return locked(() => read()).then(normalize);
}

function save(state) {
  return locked(() => write(state));
}

function mutate(fn) {
  return locked(async () => {
    const state = normalize(await read()) || { members: [], entries: [], holidays: [] };
    const result = await fn(state);
    await write(state);
    return result;
  });
}

module.exports = { load, save, mutate, init, USE_DB };
