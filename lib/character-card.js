// Character card parser for SillyTavern / TavernAI v1/v2/v3 format.
// Parses PNG files (tEXt/zTXt/iTXt chunks or IEND-appended JSON) and
// extracts the structured character data.
//
// Spec: https://github.com/malfoyslastname/character-card-spec-v2

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TYPE_tEXt = 0x74455874; // 'tEXt'
const TYPE_zTXt = 0x7a545874; // 'zTXt'
const TYPE_iTXt = 0x69545874; // 'iTXt'
const TYPE_IEND = 0x49454e44; // 'IEND'
const TYPE_IHDR = 0x49484452; // 'IHDR'

/**
 * Parse a PNG buffer and extract character card JSON.
 * Returns { json, spec, png } where json is the parsed card data,
 * spec is 'v1'|'v2'|'v3', and png is the original PNG buffer.
 */
function parsePngCard(buf) {
  if (!buf || buf.length < 20) throw new Error('file too small');
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('not a PNG file');

  let found = null;
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.readUInt32BE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > buf.length) break;

    if (type === TYPE_tEXt || type === TYPE_zTXt || type === TYPE_iTXt) {
      // Find the null byte separating keyword and text
      let keywordEnd = dataStart;
      while (keywordEnd < dataEnd && buf[keywordEnd] !== 0) keywordEnd++;
      const keyword = buf.subarray(dataStart, keywordEnd).toString('utf8');
      if (keyword === 'chara' || keyword === 'ccv3') {
        let raw = null;
        if (type === TYPE_tEXt) {
          // keyword\0text
          raw = buf.subarray(keywordEnd + 1, dataEnd);
        } else if (type === TYPE_zTXt) {
          // keyword\0compression_flag(0=zlib)\0compressed_data
          const cf = keywordEnd + 1;
          if (cf < dataEnd) {
            const compressed = buf.subarray(cf + 1, dataEnd); // skip compression flag byte
            raw = zlib.inflateSync(compressed);
          }
        } else if (type === TYPE_iTXt) {
          // keyword\0language_tag\0translated_keyword\0text
          let pos = keywordEnd + 1;
          while (pos < dataEnd && buf[pos] !== 0) pos++;
          pos++; // skip language tag
          while (pos < dataEnd && buf[pos] !== 0) pos++;
          pos++; // skip translated keyword
          raw = buf.subarray(pos, dataEnd);
        }
        if (raw) {
          try {
            const text = raw.toString('utf8');
            // The text is base64-encoded JSON
            const jsonBuf = Buffer.from(text, 'base64');
            try {
              found = JSON.parse(jsonBuf.toString('utf8'));
            } catch {
              // Try parsing raw text directly (some older cards store JSON directly)
              found = JSON.parse(text);
            }
          } catch {}
        }
        if (found) break;
      }
    }

    if (type === TYPE_IEND) {
      // Some cards append JSON after IEND (old TavernAI format)
      const afterIEND = dataEnd;
      if (afterIEND < buf.length) {
        const tail = buf.subarray(afterIEND).toString('utf8').trim();
        if (tail) {
          try { found = JSON.parse(tail); } catch {}
        }
      }
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  if (!found) throw new Error('no character card data found in PNG');

  // Determine spec version
  const spec = (found.spec === 'chara_card_v2' || found.spec === 'chara_card_v3') ? 'v2' : 'v1';
  // V3 also has spec 'chara_card_v3' but structure is same as V2
  // V1 has flat structure, V2 wraps in { spec, spec_version, data }

  return { json: found, spec, png: buf };
}

/**
 * Normalize a character card to a consistent structure regardless of input version.
 * Returns a flat object with all relevant fields.
 */
function normalizeCard(json, spec) {
  const data = (spec === 'v2' && json.data) ? json.data : json;
  return {
    name: data.name || '',
    description: data.description || '',
    personality: data.personality || '',
    scenario: data.scenario || '',
    first_mes: data.first_mes || '',
    mes_example: data.mes_example || '',
    system_prompt: data.system_prompt || '',
    post_history_instructions: data.post_history_instructions || '',
    creator_notes: data.creator_notes || '',
    alternate_greetings: Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [],
    tags: Array.isArray(data.tags) ? data.tags : [],
    character_book: data.character_book || null,
    // v2 extensions
    creator: data.creator || '',
    character_version: data.character_version || '',
    extensions: data.extensions || {},
  };
}

/**
 * Save a character card to disk.
 * Stores parsed JSON + thumbnail in character_cards/ directory.
 * Returns { id, name, avatar, ...cardData }.
 */
function saveCard(cardDir, cardData, pngBuf) {
  if (!fs.existsSync(cardDir)) fs.mkdirSync(cardDir, { recursive: true });
  const id = crypto.randomUUID();
  const filePath = path.join(cardDir, `${id}.json`);
  const avatarPath = path.join(cardDir, `${id}.png`);

  // Extract the PNG image (strip metadata chunks for storage)
  // We keep the whole PNG as-is for display
  fs.writeFileSync(avatarPath, pngBuf);

  const record = { id, ...cardData, avatar: null, filePath, avatarPath };
  fs.writeFileSync(filePath, JSON.stringify(record, null, 2));
  return record;
}

/**
 * Load a card from disk.
 */
function loadCard(cardDir, id) {
  const filePath = path.join(cardDir, `${id}.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return data;
}

/**
 * List all cards in the directory.
 */
function listCards(cardDir) {
  if (!fs.existsSync(cardDir)) return [];
  const files = fs.readdirSync(cardDir).filter(f => f.endsWith('.json'));
  return files.map(f => {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(cardDir, f), 'utf8'));
      return {
        id: data.id,
        name: data.name || '',
        description: (data.description || '').slice(0, 100),
        avatar: null, // avatar is served separately
      };
    } catch { return null; }
  }).filter(Boolean);
}

module.exports = { parsePngCard, normalizeCard, saveCard, loadCard, listCards };