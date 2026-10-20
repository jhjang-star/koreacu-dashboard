// 바이브코딩DB(Postgres) → 대시보드 중계 함수 (Vercel Serverless Function)
//  접속 정보(비밀번호 포함)는 Vercel 환경변수에서만 읽음.
//  Vercel env: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require
//  (선택) VIBE_TABLE : 읽을 테이블 이름 지정. 없으면 자동 탐색.

const { Pool } = require('pg');

const pool = new Pool({ ssl: { rejectUnauthorized: false }, max: 3, connectionTimeoutMillis: 10000 });

const PREFERRED = (process.env.VIBE_TABLE || 'sales_koreacu_dashboard').replace(/[^0-9a-zA-Z_]/g, '');
const SYS = "('pg_catalog','information_schema','pg_toast')";

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function qId(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// pg_catalog.pg_tables = 권한과 무관하게 테이블 존재 여부를 보여줌
async function resolveTable(client) {
  const byName = await client.query(
    `SELECT schemaname AS s, tablename AS t FROM pg_catalog.pg_tables
       WHERE tablename=$1 AND schemaname NOT IN ${SYS}
       ORDER BY (schemaname='public') DESC LIMIT 1`, [PREFERRED]);
  if (byName.rowCount) return byName.rows[0];

  const any = await client.query(
    `SELECT schemaname AS s, tablename AS t FROM pg_catalog.pg_tables
       WHERE schemaname NOT IN ${SYS}
       ORDER BY (schemaname='public') DESC, tablename LIMIT 1`);
  if (any.rowCount) return any.rows[0];

  // 진단: 접속 DB/사용자 + 이 서버에 있는 DB 목록
  const d = (await client.query(
    `SELECT current_database() AS db, current_user AS usr,
            (SELECT string_agg(datname, ', ') FROM pg_database WHERE datistemplate=false) AS dbs`)).rows[0];
  throw new Error('테이블 없음. 접속DB=' + d.db + ' / 사용자=' + d.usr + ' / 서버의 DB목록: ' + d.dbs);
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!process.env.PGHOST) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  }
  let client;
  try {
    client = await pool.connect();
    const { s, t } = await resolveTable(client);
    const { rows, fields } = await client.query('SELECT * FROM ' + qId(s) + '.' + qId(t));
    const cols = fields.map(f => f.name);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.status(200).send('﻿' + lines.join('\n'));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).json({ error: String((e && e.message) || e) });
  } finally {
    if (client) client.release();
  }
};
