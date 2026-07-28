/*
 * xlsx-writer.js — 외부 라이브러리 없이 .xlsx 파일을 생성하는 경량 모듈.
 * 무압축(stored) ZIP + SpreadsheetML(inline string) 조합으로 표준 xlsx를 만든다.
 *
 * 사용법:
 *   var bytes = XlsxWriter.build([
 *     { name: '시트1', colWidths: [12, 20], rows: [
 *         [ {v:'제목', s: XlsxWriter.S.HEAD}, 123, {v:0.1234, s: XlsxWriter.S.PCT} ]
 *     ] }
 *   ]);
 *   // bytes: Uint8Array → Blob으로 다운로드
 */
(function (global) {
  'use strict';

  // 셀 스타일 인덱스 (styles.xml의 cellXfs 순서와 일치)
  var S = {
    TEXT: 0,      // 일반
    HEAD: 1,      // 굵게 + 회색 배경 (헤더)
    INT: 2,       // #,##0
    DEC: 3,       // #,##0.00
    PCT: 4,       // 0.00%
    BOLD: 5,      // 굵게
    BOLD_INT: 6,  // 굵게 + #,##0
    // 강조 배경 — 종합 시트에서 원금합(노랑) / 입출금 발생일(분홍)을 눈에 띄게
    YEL: 7,       // 노랑 배경 + 굵게
    YEL_INT: 8,   // 노랑 배경 + 굵게 + #,##0
    PINK: 9,      // 분홍 배경
    PINK_INT: 10, // 분홍 배경 + #,##0
    PINK_PCT: 11  // 분홍 배경 + 0.00%
  };

  function escXml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(idx) { // 0-based → A, B, ..., AA
    var s = '';
    var n = idx + 1;
    while (n > 0) {
      var r = (n - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cellXml(cell, rowIdx, colIdx) {
    if (cell === null || cell === undefined || cell === '') return '';
    var v = cell, s = 0;
    if (typeof cell === 'object') { v = cell.v; s = cell.s || 0; }
    if (v === null || v === undefined || v === '') return '';
    var ref = colName(colIdx) + (rowIdx + 1);
    if (typeof v === 'number' && isFinite(v)) {
      return '<c r="' + ref + '" s="' + s + '"><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' +
      escXml(v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    if (sheet.colWidths && sheet.colWidths.length) {
      xml += '<cols>';
      sheet.colWidths.forEach(function (w, i) {
        if (w) xml += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      });
      xml += '</cols>';
    }
    xml += '<sheetData>';
    (sheet.rows || []).forEach(function (row, r) {
      xml += '<row r="' + (r + 1) + '">';
      (row || []).forEach(function (cell, c) { xml += cellXml(cell, r, c); });
      xml += '</row>';
    });
    xml += '</sheetData></worksheet>';
    return xml;
  }

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3">' +
    '<numFmt numFmtId="164" formatCode="#,##0"/>' +
    '<numFmt numFmtId="165" formatCode="#,##0.00"/>' +
    '<numFmt numFmtId="166" formatCode="0.00%"/>' +
    '</numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Malgun Gothic"/></font>' +
    '<font><b/><sz val="11"/><name val="Malgun Gothic"/></font>' +
    '</fonts>' +
    '<fills count="5">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEDEFF3"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF2A8"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF8C9CC"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="12">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" applyFont="1" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="1" fillId="3" borderId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="1" fillId="3" borderId="0" applyFont="1" applyFill="1" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="4" borderId="0" applyFill="1" applyNumberFormat="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="4" borderId="0" applyFill="1" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

  function workbookXml(sheets) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    sheets.forEach(function (sh, i) {
      xml += '<sheet name="' + escXml(sh.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    });
    xml += '</sheets></workbook>';
    return xml;
  }

  function workbookRelsXml(sheets) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    sheets.forEach(function (sh, i) {
      xml += '<Relationship Id="rId' + (i + 1) + '" ' +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ' +
        'Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    });
    xml += '<Relationship Id="rId' + (sheets.length + 1) + '" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ' +
      'Target="styles.xml"/>';
    xml += '</Relationships>';
    return xml;
  }

  function contentTypesXml(sheets) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    sheets.forEach(function (sh, i) {
      xml += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ' +
        'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    });
    xml += '</Types>';
    return xml;
  }

  var ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" ' +
    'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
    'Target="xl/workbook.xml"/>' +
    '</Relationships>';

  // ---------- 무압축 ZIP ----------

  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    var time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((d.getSeconds() >> 1) & 0x1F);
    var date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0x0F) << 5) | (d.getDate() & 0x1F);
    return { time: time, date: date };
  }

  function zipStore(files) { // files: [{name: string, data: Uint8Array}]
    var enc = new TextEncoder();
    var now = dosDateTime(new Date());
    var entries = files.map(function (f) {
      return { nameBytes: enc.encode(f.name), data: f.data, crc: crc32(f.data), offset: 0 };
    });
    var localSize = entries.reduce(function (s, e) { return s + 30 + e.nameBytes.length + e.data.length; }, 0);
    var centralSize = entries.reduce(function (s, e) { return s + 46 + e.nameBytes.length; }, 0);
    var out = new Uint8Array(localSize + centralSize + 22);
    var dv = new DataView(out.buffer);
    var p = 0;

    entries.forEach(function (e) {
      e.offset = p;
      dv.setUint32(p, 0x04034b50, true); p += 4;   // local file header
      dv.setUint16(p, 20, true); p += 2;           // version needed
      dv.setUint16(p, 0x0800, true); p += 2;       // flags: UTF-8 names
      dv.setUint16(p, 0, true); p += 2;            // method: stored
      dv.setUint16(p, now.time, true); p += 2;
      dv.setUint16(p, now.date, true); p += 2;
      dv.setUint32(p, e.crc, true); p += 4;
      dv.setUint32(p, e.data.length, true); p += 4;
      dv.setUint32(p, e.data.length, true); p += 4;
      dv.setUint16(p, e.nameBytes.length, true); p += 2;
      dv.setUint16(p, 0, true); p += 2;            // extra length
      out.set(e.nameBytes, p); p += e.nameBytes.length;
      out.set(e.data, p); p += e.data.length;
    });

    var centralStart = p;
    entries.forEach(function (e) {
      dv.setUint32(p, 0x02014b50, true); p += 4;   // central directory header
      dv.setUint16(p, 20, true); p += 2;           // version made by
      dv.setUint16(p, 20, true); p += 2;           // version needed
      dv.setUint16(p, 0x0800, true); p += 2;
      dv.setUint16(p, 0, true); p += 2;
      dv.setUint16(p, now.time, true); p += 2;
      dv.setUint16(p, now.date, true); p += 2;
      dv.setUint32(p, e.crc, true); p += 4;
      dv.setUint32(p, e.data.length, true); p += 4;
      dv.setUint32(p, e.data.length, true); p += 4;
      dv.setUint16(p, e.nameBytes.length, true); p += 2;
      dv.setUint16(p, 0, true); p += 2;            // extra
      dv.setUint16(p, 0, true); p += 2;            // comment
      dv.setUint16(p, 0, true); p += 2;            // disk number
      dv.setUint16(p, 0, true); p += 2;            // internal attrs
      dv.setUint32(p, 0, true); p += 4;            // external attrs
      dv.setUint32(p, e.offset, true); p += 4;
      out.set(e.nameBytes, p); p += e.nameBytes.length;
    });

    dv.setUint32(p, 0x06054b50, true); p += 4;     // end of central directory
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, 0, true); p += 2;
    dv.setUint16(p, entries.length, true); p += 2;
    dv.setUint16(p, entries.length, true); p += 2;
    dv.setUint32(p, centralSize, true); p += 4;
    dv.setUint32(p, centralStart, true); p += 4;
    dv.setUint16(p, 0, true); p += 2;              // comment length
    return out;
  }

  // 시트 이름에 쓸 수 없는 문자 제거 + 31자 제한
  function sanitizeSheetName(name, fallback) {
    var s = String(name || '').replace(/[\[\]\\\/:*?]/g, ' ').trim().slice(0, 31);
    return s || fallback || 'Sheet';
  }

  function build(sheets) {
    var enc = new TextEncoder();
    var files = [
      { name: '[Content_Types].xml', data: enc.encode(contentTypesXml(sheets)) },
      { name: '_rels/.rels', data: enc.encode(ROOT_RELS_XML) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml(sheets)) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml(sheets)) },
      { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) }
    ];
    sheets.forEach(function (sh, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(sheetXml(sh)) });
    });
    return zipStore(files);
  }

  var api = { S: S, build: build, sanitizeSheetName: sanitizeSheetName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.XlsxWriter = api;
})(typeof window !== 'undefined' ? window : globalThis);
