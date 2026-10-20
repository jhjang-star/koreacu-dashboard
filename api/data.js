// 바이브코딩DB(Postgres) → 대시보드 중계 함수 (Vercel Serverless Function)
//  접속 정보(비밀번호 포함)는 Vercel 환경변수에서만 읽음.
//  Vercel env: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require
//  (선택) VIBE_TABLE : 읽을 테이블 이름. 없으면 'sales_koreacu_dashboard'.
//  (선택) VIBE_DBS   : 추가로 찾아볼 데이터베이스 목록(콤마구분). 기본 'ai_admin_query'.

const { Pool, Client } = require('pg');

const pool = new Pool({ ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10000 });

const PREFERRED = (process.env.VIBE_TABLE || 'sales_koreacu_dashboard').replace(/[^0-9a-zA-Z_]/g, '');
const EXTRA_DBS = (process.env.VIBE_DBS || 'ai_admin_query').split(',').map(s => s.trim()).filter(Boolean);
const SYS = "('pg_catalog','information_schema','pg_toast')";

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function qId(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// 현재 연결에서 대상 테이블(스키마/이름)을 찾는다. 없으면 null.
async function findTable(c) {
  const byName = await c.query(
    `SELECT schemaname AS s, tablename AS t FROM pg_catalog.pg_tables
       WHERE tablename=$1 AND schemaname NOT IN ${SYS}
       ORDER BY (schemaname='public') DESC LIMIT 1`, [PREFERRED]);
  if (byName.rowCount) return byName.rows[0];
  const any = await c.query(
    `SELECT schemaname AS s, tablename AS t FROM pg_catalog.pg_tables
       WHERE schemaname NOT IN ${SYS} ORDER BY (schemaname='public') DESC, tablename LIMIT 1`);
  return any.rowCount ? any.rows[0] : null;
}

function readCsv(client, s, t) {
  return client.query('SELECT * FROM ' + qId(s) + '.' + qId(t)).then(({ rows, fields }) => {
    const cols = fields.map(f => f.name);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
    return '﻿' + lines.join('\n');
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!process.env.PGHOST) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  }

  let csv = null, tried = [];
  // 1) 기본 연결(PGDATABASE)에서 시도
  try {
    const c = await pool.connect();
    try {
      tried.push(process.env.PGDATABASE || '(default)');
      const f = await findTable(c);
      if (f) csv = await readCsv(c, f.s, f.t);
    } finally { c.release(); }
  } catch (e) { tried.push((process.env.PGDATABASE || '(default)') + '!' + (e.code || e.message)); }

  // 2) 못 찾았으면 후보 DB들(기본 ai_admin_query)에 직접 접속해서 시도
  if (csv === null) {
    for (const db of EXTRA_DBS) {
      if (db === process.env.PGDATABASE) continue;
      const c = new Client({
        host: process.env.PGHOST, port: process.env.PGPORT || 5432,
        user: process.env.PGUSER, password: process.env.PGPASSWORD,
        database: db, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10000,
      });
      try {
        await c.connect();
        tried.push(db);
        const f = await findTable(c);
        if (f) { csv = await readCsv(c, f.s, f.t); await c.end(); break; }
        await c.end();
      } catch (e) { tried.push(db + '!' + (e.code || e.message)); try { await c.end(); } catch (_) {} }
    }
  }

  if (csv !== null) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    return res.status(200).send(csv);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(500).json({ error: '대상 테이블(' + PREFERRED + ')을 찾지 못했습니다. 시도한 DB: ' + tried.join(', ') });
};
