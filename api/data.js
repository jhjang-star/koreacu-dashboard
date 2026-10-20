// 바이브코딩DB(Postgres) → 대시보드 중계 함수 (Vercel Serverless Function)
// ------------------------------------------------------------------
//  · 대시보드(index.html)가 /api/data 를 호출하면, 여기서 바이브DB에 접속해
//    'sales_koreacu_dashboard' 테이블을 읽어 CSV로 돌려줍니다.
//  · 접속 정보(비밀번호 포함)는 Vercel 환경변수에서만 읽습니다. 코드/페이지에 노출되지 않습니다.
//
//  필요한 Vercel 환경변수 (백엔드 개발자에게 받은 접속키):
//    PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE=require
//  (선택) VIBE_TABLE : 테이블 이름이 다르면 지정. 기본값 sales_koreacu_dashboard

const { Pool } = require('pg');

// 서버리스 환경에서 커넥션 재사용을 위해 핸들러 바깥(모듈 스코프)에 Pool 생성
const pool = new Pool({
  ssl: { rejectUnauthorized: false },   // 바이브DB는 SSL 필수 (PGSSLMODE=require)
  max: 3,
  connectionTimeoutMillis: 10000,
});

const TABLE = (process.env.VIBE_TABLE || 'sales_koreacu_dashboard').replace(/[^0-9a-zA-Z_]/g, '');

function csvEscape(v) {
  v = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { rows, fields } = await pool.query('SELECT * FROM "' + TABLE + '"');
    const cols = fields.map(f => f.name);
    const lines = [cols.join(',')];
    for (const r of rows) lines.push(cols.map(c => csvEscape(r[c])).join(','));
    const csv = '﻿' + lines.join('\n');          // 엑셀 호환 BOM
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).send(csv);
  } catch (e) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
