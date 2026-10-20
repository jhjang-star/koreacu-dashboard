// 바이브코딩DB(Postgres) → 대시보드 중계 함수 (Vercel Serverless Function)
// ------------------------------------------------------------------
//  · 대시보드(index.html)가 /api/data 를 호출하면, 여기서 바이브DB에 접속해
//    대상 테이블을 읽어 CSV로 돌려줍니다.
//  · 접속 정보(비밀번호 포함)는 Vercel 환경변수에서만 읽습니다. 코드/페이지에 노출되지 않습니다.
//
//  필요한 Vercel 환경변수 (백엔드 개발자에게 받은 접속키):
//    PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require
//  (선택) VIBE_TABLE : 읽을 테이블 이름을 직접 지정. 없으면 자동 탐색.

const { Pool } = require('pg');

const pool = new Pool({
  ssl: { rejectUnauthorized: false },   // 바이브DB는 SSL 필수 (PGSSLMODE=require)
  max: 3,
  connectionTimeoutMillis: 10000,
});

const PREFERRED = (process.env.VIBE_TABLE || 'sales_koreacu_dashboard').replace(/[^0-9a-zA-Z_]/g, '');

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

// 읽을 테이블 결정: 선호 이름이 있으면 그걸, 없으면 public 스키마에서 자동 탐색
async function resolveTable(client) {
  const chk = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1 LIMIT 1",
    [PREFERRED]
  );
  if (chk.rowCount) return PREFERRED;

  const cand = await client.query(
    `SELECT t.table_name,
            bool_or(c.column_name IN ('강의명','콘텐츠','소속강의')) AS looks_right
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      GROUP BY t.table_name
      ORDER BY looks_right DESC, t.table_name
      LIMIT 1`
  );
  if (cand.rowCount) return cand.rows[0].table_name;
  throw new Error('public 스키마에서 읽을 테이블을 찾지 못했습니다');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (!process.env.PGHOST) {                       // 접속키(환경변수) 미설정
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(503).json({ error: 'DB_NOT_CONFIGURED' });
  }

  let client;
  try {
    client = await pool.connect();
    const table = await resolveTable(client);
    const { rows, fields } = await client.query('SELECT * FROM "' + table.replace(/"/g, '') + '"');
    const cols = fields.map(f => f.name);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).send('﻿' + lines.join('\n'));
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).json({ error: String((e && e.message) || e) });
  } finally {
    if (client) client.release();
  }
};
