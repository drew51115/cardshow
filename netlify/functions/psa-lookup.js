// Netlify Function: psa-lookup
// POST { cert: string, grader: 'PSA'|'CGC'|'SGC' }
// Returns normalized card object matching CardShow field names.
//
// PSA API docs: https://api.psacard.com/publicapi/swagger/index.html
// CGC API docs: https://api.cgccomics.com (cards endpoint)

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { cert, grader } = body;
  if (!cert) {
    return { statusCode: 400, body: JSON.stringify({ error: 'cert is required' }) };
  }

  const g = (grader || '').toUpperCase();

  try {
    if (g === 'CGC') {
      return await lookupCGC(cert);
    }
    // Default to PSA for PSA and SGC (SGC uses PSA registry lookup format)
    return await lookupPSA(cert, g || 'PSA');
  } catch (err) {
    console.error('psa-lookup error:', err.message);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Lookup failed', detail: err.message }),
    };
  }
};

// ── PSA lookup ───────────────────────────────────────────────────────────────
async function lookupPSA(cert, grader) {
  const token = process.env.PSA_API_TOKEN;
  if (!token) {
    return { statusCode: 503, body: JSON.stringify({ error: 'PSA_API_TOKEN not configured' }) };
  }

  const url = `https://api.psacard.com/publicapi/cert/GetByCertNumber/${encodeURIComponent(cert)}`;

  // Retry up to 3 times on 429 with exponential backoff (1s, 2s, 4s)
  let lastRes;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    lastRes = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (lastRes.status !== 429) break;
  }

  const res = lastRes;
  if (!res.ok) {
    const text = await res.text();
    const friendly = res.status === 429
      ? 'PSA rate limit reached — wait a moment and try again'
      : `PSA API error ${res.status}`;
    return {
      statusCode: res.status,
      body: JSON.stringify({ error: friendly, detail: text }),
    };
  }

  const data = await res.json();
  // PSA returns { PSACert: { ... } }
  const c = data?.PSACert || data;

  const normalized = normalizePSA(c, grader, cert);
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  };
}

function normalizePSA(c, grader, cert) {
  // PSA field names vary by API version; try common keys
  const subject = c.Subject || c.CardName || c.Description || '';
  const year    = c.Year || c.CardYear || extractYear(subject);
  const grade   = c.GradeDescription || c.CardGrade || c.Grade || '';
  const gradeNum = parseFloat(grade) || parseFloat(c.PSAGrade) || null;

  return {
    player:   c.Player || c.PlayerName || extractPlayer(subject),
    cardSet:  c.Brand || c.SetName || c.CardSet || '',
    year:     year ? String(year) : '',
    cardNum:  c.CardNumber || c.Number || '',
    parallel: c.Variety || c.Parallel || '',
    grade:    gradeNum,
    grader:   grader || 'PSA',
    certNum:  c.CertNumber || c.PSACertNumber || cert,
    sport:    mapSport(c.Category || c.Sport || ''),
    rawTitle: subject,
  };
}

// ── CGC lookup ───────────────────────────────────────────────────────────────
async function lookupCGC(cert) {
  const token = process.env.CGC_API_TOKEN;
  if (!token) {
    return { statusCode: 503, body: JSON.stringify({ error: 'CGC_API_TOKEN not configured' }) };
  }

  // CGC Trading Cards API
  const url = `https://api.cgccomics.com/api/cards/cert/${encodeURIComponent(cert)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return {
      statusCode: res.status,
      body: JSON.stringify({ error: `CGC API error ${res.status}`, detail: text }),
    };
  }

  const data = await res.json();
  const c = data?.result || data;

  const subject = c.title || c.cardName || c.description || '';
  const gradeNum = parseFloat(c.grade) || null;

  const normalized = {
    player:   c.subject || c.player || extractPlayer(subject),
    cardSet:  c.setName || c.publisher || '',
    year:     c.year ? String(c.year) : extractYear(subject),
    cardNum:  c.cardNumber || '',
    parallel: c.variant || c.variety || '',
    grade:    gradeNum,
    grader:   'CGC',
    certNum:  c.certNumber || cert,
    sport:    mapSport(c.category || ''),
    rawTitle: subject,
  };

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(normalized),
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function extractYear(str) {
  const m = (str || '').match(/\b(19[5-9]\d|20[0-3]\d)\b/);
  return m ? m[1] : '';
}

function extractPlayer(str) {
  // Remove leading year, then take first 2-3 words before a set keyword
  return (str || '')
    .replace(/^\d{4}[-\s]/, '')
    .replace(/\s+(Topps|Panini|Prizm|Bowman|Fleer|Upper Deck|Donruss|Score|Select|Chrome|Optic|SP|PSA|BGS|CGC|SGC|RC|Rookie|Auto|#\d+).*/i, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join(' ');
}

function mapSport(raw) {
  const s = (raw || '').toLowerCase();
  if (s.includes('baseball') || s.includes('mlb'))   return 'Baseball';
  if (s.includes('basketball') || s.includes('nba')) return 'Basketball';
  if (s.includes('football') || s.includes('nfl'))   return 'Football';
  if (s.includes('hockey') || s.includes('nhl'))     return 'Hockey';
  if (s.includes('soccer') || s.includes('mls'))     return 'Soccer';
  if (s.includes('pokemon') || s.includes('tcg') || s.includes('trading card game')) return 'TCG';
  return '';
}
