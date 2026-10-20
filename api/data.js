// 바이브코딩DB(Postgres) → 대시보드 중계 함수 (Vercel Serverless Function)
// ------------------------------------------------------------------
//  · 대시보드(index.html)가 /api/data 를 호출하면, 여기서 바이브DB에 접속해
//    대상 테이블을 읽어 CSV로 돌려줍니다.
//  · 접속 정보(비밀번호 포함)는 Vercel 환경변수에서만 읽습니다.
//
//  Vercel 환경변수: PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require
//  (선택) VIBE_TABLE : 읽을 테이블 이름을 직접 지정. 없으면 모든 스키마에서 자동 탐색.

const { Pool } = require('pg');

const pool = new Pool({
  ssl: { rejectUnauthorized: false },
  max: 3,
  connectionTimeoutMillis: 10000,
});

const PREFERRED = (process.env.VIBE_TABLE || 'sales_koreacu_dashboard').replace(/[^0-9a-zA-Z_]/g, '');
const SYS_SCHEMAS = "('pg_catalog','information_schema','pg_toast')";

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
function qId(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

// 읽을 테이블을 모든(시스템 제외) 스키마에서 찾는다.
async function resolveTable(client) {
  // 1) 선호 이름 우선 (public 우선)
  const byName = await client.query(
    `SELECT table_schema, table_name FROM information_schema.tables
       WHERE table_type='BASE TABLE' AND table_name=$1
         AND table_schema NOT IN ${SYS_SCHEMAS}
       ORDER BY (table_schema='public') DESC
       LIMIT 1`, [PREFERRED]);
  if (byName.rowCount) return byName.rows[0];

  // 2) 기대 컬럼(강의명/콘텐츠/소속강의)을 가진 테이블
  const byCol = await client.query(
    `SELECT t.table_schema, t.table_name,
            bool_or(c.column_name IN ('강의명','콘텐츠','소속강의')) AS looks
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema=t.table_schema AND c.table_name=t.table_name
      WHERE t.table_type='BASE TABLE' AND t.table_schema NOT IN ${SYS_SCHEMAS}
      GROUP BY t.table_schema, t.table_name
      ORDER BY looks DESC, (t.table_schema='public') DESC, t.table_name
      LIMIT 1`);
  if (byCol.rowCount && byCol.rows[0].looks) return byCol.rows[0];
  if (byCol.rowCount) return byCol.rows[0];  // 그래도 뭔가 있으면 첫 테이블

  // 3) 못 찾음 → 보이는 테이블 목록을 에러에 담아 진단
  const all = await client.query(
    `SELECT table_schema||'.'||table_name AS t FROM information_schema.tables
       WHERE table_type='BASE TABLE' AND table_schema NOT IN ${SYS_SCHEMAS} LIMIT 30`);
  throw new Error('읽을 테이블을 찾지 못했습니다. 접속 DB=' + (process.env.PGDATABASE || '?') +
    ' / 보이는 테이블: ' + (all.rows.map(r => r.t).join(', ') || '(없음)'));
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
    const { table_schema, table_name } = await resolveTable(client);
    const { rows, fields } = await client.query('SELECT * FROM ' + qId(table_schema) + '.' + qId(table_name));
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
