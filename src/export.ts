// Port of modules.py's export_docx / export_pdf. reportlab and python-docx
// don't run on Workers, so this reimplements both with JS libraries that
// do: `docx` for Word, `pdf-lib` for PDF. Same reading order as the report
// tab: exec summary, speed read, structural positioning, Pulse table,
// sections in published order, beyond-seven-days, then open reader notes.

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow,
  TableCell, WidthType, AlignmentType, BorderStyle, ExternalHyperlink,
} from 'docx'
import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage, PDFName, PDFArray, PDFString } from 'pdf-lib'
import type { ViewModel, Note } from './types'

// Maida Vale brand green (#295650), matching the masthead/logo colour.
const NAVY = { r: 0x29 / 255, g: 0x56 / 255, b: 0x50 / 255 }
const SLATE = { r: 0x64 / 255, g: 0x74 / 255, b: 0x8b / 255 }
const RED = { r: 0x99 / 255, g: 0x1b / 255, b: 0x1b / 255 }

// pdf-lib's StandardFonts use WinAnsi encoding, which lacks most Unicode
// punctuation the brief's prose uses (em dash, curly quotes, ellipsis).
// Fold those down to ASCII equivalents so drawText() never throws.
function pdfSafe(text: string): string {
  return (text || '')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u00a0/g, ' ')
}

function plain(html: string): string {
  let t = (html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n')
  t = t.replace(/<[^>]+>/g, '')
  return t.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

// ============================================================== Word (docx)
export async function exportDocx(vm: ViewModel, notes: Note[]): Promise<Uint8Array> {
  const children: Paragraph[] = []

  children.push(new Paragraph({
    children: [new TextRun({ text: 'WEEKLY INDUSTRY NEWS EXECUTIVE BRIEFING', bold: true, size: 30, color: '295650' })],
  }))
  children.push(new Paragraph({
    children: [new TextRun({ text: `Week ${vm.week} · ${vm.label}`, size: 20, color: '64748B' })],
    spacing: { after: 200 },
  }))

  if (vm.exec_summary) {
    children.push(new Paragraph({ text: 'Executive Summary', heading: HeadingLevel.HEADING_1 }))
    children.push(new Paragraph({ text: plain(vm.exec_summary) }))
  }

  if (vm.speed_read?.length) {
    children.push(new Paragraph({ text: 'Speed Read', heading: HeadingLevel.HEADING_1 }))
    for (const line of vm.speed_read) {
      children.push(new Paragraph({ text: plain(line), bullet: { level: 0 } }))
    }
  }

  if (vm.structural) {
    children.push(new Paragraph({ text: 'Structural Macroeconomic Positioning', heading: HeadingLevel.HEADING_1 }))
    children.push(new Paragraph({ text: plain(vm.structural) }))
  }

  const pulseRows = (vm.indicators || []).flatMap((g) => g.items || [])
  const docChildren: (Paragraph | Table)[] = [...children]

  if (pulseRows.length) {
    docChildren.push(new Paragraph({ text: 'Weekly Pulse', heading: HeadingLevel.HEADING_1 }))
    const headCells = ['Indicator', 'This week', 'Previous', 'Direction', 'Implication'].map((h) =>
      new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }))
    const rows = [new TableRow({ children: headCells })]
    for (const it of pulseRows) {
      const chg = it.change
      const arrow = typeof chg === 'number' && chg > 0 ? '↑' : typeof chg === 'number' && chg < 0 ? '↓' : '→'
      rows.push(new TableRow({
        children: [
          String(it.name), String(it.current), String(it.prior), arrow, plain(it.implication || ''),
        ].map((v) => new TableCell({ children: [new Paragraph({ text: v })] })),
      }))
    }
    docChildren.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }))
  }

  for (const sec of vm.sections || []) {
    docChildren.push(new Paragraph({ text: sec.title, heading: HeadingLevel.HEADING_1 }))
    for (const item of sec.items || []) {
      const grade = item.impact_label || ''
      const runs = [new TextRun({ text: item.title, bold: true })]
      if (grade) {
        runs.push(new TextRun({
          text: `  [${grade}]`, size: 16,
          color: grade === 'Negative' ? '991B1B' : '64748B',
        }))
      }
      docChildren.push(new Paragraph({ children: runs }))
      docChildren.push(new Paragraph({ text: plain(item.body) }))
      if (item.source) {
        // When the item carries an exact source_url (backfilled from a
        // Reference List or extracted directly), make "Source: X" a real
        // clickable hyperlink in the Word doc instead of plain italic text
        // the reader has to copy-search for themselves.
        const sourceRun = new TextRun({ text: 'Source: ' + item.source, italics: true, size: 16, color: '64748B' })
        if (item.source_url) {
          docChildren.push(new Paragraph({
            children: [
              new TextRun({ text: 'Source: ', italics: true, size: 16, color: '64748B' }),
              new ExternalHyperlink({
                link: item.source_url,
                children: [new TextRun({ text: item.source, italics: true, size: 16, color: '295650', underline: {} })],
              }),
            ],
          }))
        } else {
          docChildren.push(new Paragraph({ children: [sourceRun] }))
        }
      }
    }
  }

  if (vm.beyond) {
    docChildren.push(new Paragraph({ text: 'Beyond Seven Days', heading: HeadingLevel.HEADING_1 }))
    docChildren.push(new Paragraph({ text: plain(vm.beyond) }))
  }

  const openNotes = notes.filter((n) => n.edition === vm.id && !n.resolved)
  if (openNotes.length) {
    docChildren.push(new Paragraph({ text: 'Reader Notes', heading: HeadingLevel.HEADING_1 }))
    for (const n of openNotes) {
      docChildren.push(new Paragraph({
        bullet: { level: 0 },
        children: [
          new TextRun({ text: `${n.author || 'Anonymous'}: `, bold: true }),
          new TextRun({ text: plain(n.text || '') }),
        ],
      }))
      for (const rep of n.replies || []) {
        docChildren.push(new Paragraph({
          bullet: { level: 1 },
          children: [
            new TextRun({ text: `${rep.author || 'Anonymous'}: `, bold: true }),
            new TextRun({ text: plain(rep.text || '') }),
          ],
        }))
      }
    }
  }

  const doc = new Document({
    sections: [{ children: docChildren }],
    styles: { default: { document: { run: { font: 'Calibri', size: 21 } } } },
  })
  return await Packer.toBuffer(doc)
}

// =================================================================== PDF
const MARGIN = 20 * 2.834645 // 20mm -> pt (1mm ~= 2.83465pt)
const PAGE_W = 595.28 // A4 pt
const PAGE_H = 841.89

class PdfWriter {
  doc!: PDFDocument
  page!: PDFPage
  y = 0
  regular!: PDFFont
  bold!: PDFFont
  italic!: PDFFont

  static async create(): Promise<PdfWriter> {
    const w = new PdfWriter()
    w.doc = await PDFDocument.create()
    w.regular = await w.doc.embedFont(StandardFonts.Helvetica)
    w.bold = await w.doc.embedFont(StandardFonts.HelveticaBold)
    w.italic = await w.doc.embedFont(StandardFonts.HelveticaOblique)
    w.newPage()
    return w
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    this.y = PAGE_H - MARGIN
  }

  ensureSpace(need: number) {
    if (this.y - need < MARGIN) this.newPage()
  }

  wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
    const words = (text || '').split(/\s+/).filter(Boolean)
    const lines: string[] = []
    let cur = ''
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word
      if (font.widthOfTextAtSize(test, size) > maxWidth && cur) {
        lines.push(cur)
        cur = word
      } else {
        cur = test
      }
    }
    if (cur) lines.push(cur)
    return lines.length ? lines : ['']
  }

  drawParagraph(text: string, opts: { font?: PDFFont; size?: number; color?: { r: number; g: number; b: number }; leading?: number; spaceAfter?: number; maxWidth?: number } = {}) {
    const font = opts.font || this.regular
    const size = opts.size ?? 9.2
    const leading = opts.leading ?? size * 1.4
    const color = opts.color ?? { r: 0, g: 0, b: 0 }
    const maxWidth = opts.maxWidth ?? (PAGE_W - MARGIN * 2)
    // Handle explicit newlines (from plain() conversion) as paragraph breaks.
    const rawLines = pdfSafe(text || '').split('\n')
    for (const raw of rawLines) {
      const lines = this.wrapText(raw, font, size, maxWidth)
      for (const line of lines) {
        this.ensureSpace(leading)
        this.page.drawText(line, {
          x: MARGIN, y: this.y - leading, size, font,
          color: rgb(color.r, color.g, color.b),
        })
        this.y -= leading
      }
    }
    this.y -= (opts.spaceAfter ?? 4)
  }

  // A line that renders as "Source: <name>" with the name underlined in
  // navy and wrapped in a clickable URI link annotation, falling back to
  // plain italic text when no exact source_url is on file. pdf-lib has no
  // built-in hyperlink helper (only low-level PDFAnnotation primitives), so
  // this constructs a Link annotation dict directly and attaches it to the
  // page's /Annots array over the rectangle the name was drawn in.
  drawSourceLine(label: string, name: string, url: string | undefined, opts: { font?: PDFFont; size?: number; color?: { r: number; g: number; b: number }; spaceAfter?: number } = {}) {
    const font = opts.font || this.italic
    const size = opts.size ?? 7.6
    const color = opts.color ?? SLATE
    const prefix = pdfSafe(label)
    const nameText = pdfSafe(name)
    this.ensureSpace(size * 1.4)
    const lineY = this.y - size * 1.4
    this.page.drawText(prefix, { x: MARGIN, y: lineY, size, font, color: rgb(color.r, color.g, color.b) })
    const prefixW = font.widthOfTextAtSize(prefix, size)
    const nameX = MARGIN + prefixW
    const nameColor = url ? NAVY : color
    this.page.drawText(nameText, { x: nameX, y: lineY, size, font, color: rgb(nameColor.r, nameColor.g, nameColor.b) })
    const nameW = font.widthOfTextAtSize(nameText, size)
    if (url) {
      // Underline to signal "clickable", same visual language as the Word export.
      this.page.drawLine({
        start: { x: nameX, y: lineY - 1 }, end: { x: nameX + nameW, y: lineY - 1 },
        thickness: 0.5, color: rgb(nameColor.r, nameColor.g, nameColor.b),
      })
      this.linkAnnotation([nameX, lineY - 2, nameX + nameW, lineY + size], url)
    }
    this.y -= size * 1.4
    this.y -= (opts.spaceAfter ?? 7)
  }

  // Attaches a clickable URI link annotation over `rect` ([x1,y1,x2,y2] in
  // page points) on the current page. pdf-lib exposes no page.drawLink(), so
  // this builds the /Annot /Link dict with a /URI action by hand and
  // registers it in the page's /Annots array.
  linkAnnotation(rect: [number, number, number, number], url: string) {
    const annotRef = this.doc.context.register(
      this.doc.context.obj({
        Type: 'Annot',
        Subtype: 'Link',
        Rect: rect,
        Border: [0, 0, 0],
        A: {
          Type: 'Action',
          S: 'URI',
          URI: PDFString.of(url),
        },
      }),
    )
    const existing = this.page.node.lookup(PDFName.of('Annots'), PDFArray)
    const annots = existing || this.doc.context.obj([])
    annots.push(annotRef)
    this.page.node.set(PDFName.of('Annots'), annots)
  }
}

export async function exportPdf(vm: ViewModel, notes: Note[]): Promise<Uint8Array> {
  const w = await PdfWriter.create()

  w.drawParagraph('WEEKLY INDUSTRY NEWS EXECUTIVE BRIEFING', { font: w.bold, size: 16, color: NAVY, spaceAfter: 2 })
  w.drawParagraph(`Week ${vm.week} · ${vm.label}`, { size: 9, color: SLATE, spaceAfter: 10 })

  const h1 = (text: string) => w.drawParagraph(text, { font: w.bold, size: 12.5, color: NAVY, spaceAfter: 6 })

  if (vm.exec_summary) {
    h1('Executive Summary')
    w.drawParagraph(plain(vm.exec_summary), { spaceAfter: 8 })
  }

  if (vm.speed_read?.length) {
    h1('Speed Read')
    for (const line of vm.speed_read) w.drawParagraph('• ' + plain(line), { spaceAfter: 3 })
    w.y -= 4
  }

  if (vm.structural) {
    h1('Structural Macroeconomic Positioning')
    w.drawParagraph(plain(vm.structural), { spaceAfter: 8 })
  }

  const pulseRows = (vm.indicators || []).flatMap((g) => g.items || [])
  if (pulseRows.length) {
    h1('Weekly Pulse')
    const colW = [95, 65, 65, 22, 240]
    const headers = ['Indicator', 'This week', 'Previous', 'Dir', 'Implication']
    w.ensureSpace(16)
    let x = MARGIN
    // header background
    w.page.drawRectangle({ x: MARGIN, y: w.y - 14, width: PAGE_W - MARGIN * 2, height: 14, color: rgb(NAVY.r, NAVY.g, NAVY.b) })
    for (let i = 0; i < headers.length; i++) {
      w.page.drawText(headers[i], { x: x + 3, y: w.y - 11, size: 7.6, font: w.bold, color: rgb(1, 1, 1) })
      x += colW[i]
    }
    w.y -= 16
    for (const it of pulseRows) {
      const chg = it.change
      const arrow = typeof chg === 'number' && chg > 0 ? 'Up' : typeof chg === 'number' && chg < 0 ? 'Down' : 'Flat'
      const cells = [String(it.name), String(it.current), String(it.prior), arrow, plain(it.implication || '')].map(pdfSafe)
      // compute row height from wrapped implication text
      const implLines = w.wrapText(cells[4], w.regular, 7.6, colW[4] - 6)
      const rowH = Math.max(12, implLines.length * 9.5 + 4)
      w.ensureSpace(rowH)
      x = MARGIN
      for (let i = 0; i < cells.length; i++) {
        if (i === 4) {
          let ly = w.y - 8
          for (const l of implLines) {
            w.page.drawText(l, { x: x + 3, y: ly, size: 7.6, font: w.regular, color: rgb(0, 0, 0) })
            ly -= 9.5
          }
        } else {
          w.page.drawText(cells[i], { x: x + 3, y: w.y - 8, size: 7.6, font: w.regular, color: rgb(0, 0, 0) })
        }
        x += colW[i]
      }
      w.page.drawLine({
        start: { x: MARGIN, y: w.y - rowH }, end: { x: PAGE_W - MARGIN, y: w.y - rowH },
        thickness: 0.4, color: rgb(0.8, 0.84, 0.88),
      })
      w.y -= rowH
    }
    w.y -= 8
  }

  for (const sec of vm.sections || []) {
    h1(sec.title)
    for (const item of sec.items || []) {
      const grade = item.impact_label || ''
      const titleLine = item.title + (grade ? `  [${grade}]` : '')
      w.drawParagraph(titleLine, { font: w.bold, size: 9.8, color: NAVY, spaceAfter: 2 })
      w.drawParagraph(plain(item.body), { spaceAfter: 5 })
      if (item.source) {
        // Exact-URL items get a real clickable Link annotation (same fix
        // already applied to the Word export); items without a confirmed
        // source_url fall back to the original plain italic text.
        w.drawSourceLine('Source: ', item.source, item.source_url, { font: w.italic, size: 7.6, color: SLATE, spaceAfter: 7 })
      }
    }
  }

  if (vm.beyond) {
    h1('Beyond Seven Days')
    w.drawParagraph(plain(vm.beyond), { spaceAfter: 8 })
  }

  const openNotes = notes.filter((n) => n.edition === vm.id && !n.resolved)
  if (openNotes.length) {
    h1('Reader Notes')
    for (const n of openNotes) {
      w.drawParagraph(`• ${n.author || 'Anonymous'}: ${plain(n.text || '')}`, { spaceAfter: 3 })
      for (const rep of n.replies || []) {
        w.drawParagraph(`    – ${rep.author || 'Anonymous'}: ${plain(rep.text || '')}`, { spaceAfter: 3, size: 8.4 })
      }
    }
  }

  return await w.doc.save()
}

// =========================================================== Board-pack PDF
// A short, presentation-ready summary for the director/board distribution —
// distinct from exportPdf() above, which reproduces the full report in
// reading order. This is a cover page + at-a-glance dashboard + the top
// critical/high items only + the Watch List, so it reads in under two
// minutes rather than the full brief's ten-plus.
const GRADE_COLOR: Record<string, { r: number; g: number; b: number }> = {
  critical: RED,
  high: { r: 0xd9 / 255, g: 0x77 / 255, b: 0x06 / 255 },
  medium: { r: 0x15 / 255, g: 0x80 / 255, b: 0x3d / 255 },
  low: SLATE,
}

export async function exportBoardPackPdf(vm: ViewModel): Promise<Uint8Array> {
  const w = await PdfWriter.create()

  // ---------- Cover ----------
  w.y = PAGE_H - MARGIN - 60
  w.drawParagraph('BOARD PACK', { font: w.bold, size: 11, color: SLATE, spaceAfter: 4 })
  w.drawParagraph('Weekly Industry Brief', { font: w.bold, size: 24, color: NAVY, spaceAfter: 6 })
  w.drawParagraph(`Week ${vm.week} · ${vm.label}`, { size: 11, color: SLATE, spaceAfter: 2 })
  w.drawParagraph(`Prepared for Al Bukhary Group`, { size: 9.5, color: SLATE, spaceAfter: 30 })

  if (vm.exec_summary) {
    w.drawParagraph('AT A GLANCE', { font: w.bold, size: 10, color: NAVY, spaceAfter: 4 })
    w.drawParagraph(plain(vm.exec_summary), { size: 10, spaceAfter: 18 })
  }

  // Delta summary (new / escalated) right on the cover, since that's the
  // single thing a director needs before a meeting — mirrors the
  // Lead-with-what-changed card on the web app.
  const notable = (vm.delta || []).filter((d) => d.status === 'new' || d.status === 'escalated').slice(0, 6)
  if (notable.length) {
    w.drawParagraph('WHAT CHANGED THIS WEEK', { font: w.bold, size: 10, color: NAVY, spaceAfter: 4 })
    for (const d of notable) {
      const tag = d.status === 'new' ? '[NEW] ' : '[ESCALATED] '
      w.drawParagraph(tag + plain(d.title), { size: 9.3, spaceAfter: 3 })
    }
    w.y -= 8
  }

  // ---------- Indicator dashboard ----------
  const pulseRows = (vm.indicators || []).flatMap((g) => g.items || [])
  if (pulseRows.length) {
    w.newPage()
    w.drawParagraph('MARKET DASHBOARD', { font: w.bold, size: 13, color: NAVY, spaceAfter: 10 })
    const cardW = (PAGE_W - MARGIN * 2 - 16) / 3
    const cardH = 58
    let col = 0
    let rowStartY = w.y
    for (const it of pulseRows) {
      if (col === 3) { col = 0; rowStartY -= cardH + 10; w.y = rowStartY }
      if (rowStartY - cardH < MARGIN) { w.newPage(); rowStartY = w.y; col = 0 }
      const x = MARGIN + col * (cardW + 8)
      const topY = rowStartY
      w.page.drawRectangle({
        x, y: topY - cardH, width: cardW, height: cardH,
        borderColor: rgb(0.86, 0.89, 0.92), borderWidth: 0.6, color: rgb(0.98, 0.98, 0.99),
      })
      const nameLines = w.wrapText(pdfSafe(String(it.name)), w.bold, 8, cardW - 12)
      w.page.drawText(nameLines[0] || '', { x: x + 6, y: topY - 14, size: 8, font: w.bold, color: rgb(NAVY.r, NAVY.g, NAVY.b) })
      const dirColor = it.dir === 'up' ? GRADE_COLOR.medium : it.dir === 'down' ? RED : SLATE
      const arrow = it.dir === 'up' ? 'UP' : it.dir === 'down' ? 'DOWN' : 'FLAT'
      w.page.drawText(pdfSafe(String(it.current)), { x: x + 6, y: topY - 32, size: 13, font: w.bold, color: rgb(0, 0, 0) })
      w.page.drawText(arrow, { x: x + 6, y: topY - 46, size: 7.2, font: w.bold, color: rgb(dirColor.r, dirColor.g, dirColor.b) })
      w.page.drawText(`prev ${pdfSafe(String(it.prior))}`, { x: x + cardW - 6 - w.regular.widthOfTextAtSize(`prev ${it.prior}`, 7), y: topY - 46, size: 7, font: w.regular, color: rgb(SLATE.r, SLATE.g, SLATE.b) })
      col++
    }
    w.y = rowStartY - cardH - 16
  }

  // ---------- Top critical / high items only ----------
  const priorityItems: { section: string; item: ViewModel['sections'][number]['items'][number] }[] = []
  for (const sec of vm.sections || []) {
    for (const item of sec.items || []) {
      if (item.impact === 'critical' || item.impact === 'high') priorityItems.push({ section: sec.title, item })
    }
  }
  if (priorityItems.length) {
    w.newPage()
    w.drawParagraph('PRIORITY ITEMS', { font: w.bold, size: 13, color: NAVY, spaceAfter: 2 })
    w.drawParagraph('Critical and high-impact developments only — see the full report for complete coverage.', { size: 8.3, color: SLATE, spaceAfter: 10 })
    for (const { section, item } of priorityItems) {
      w.ensureSpace(40)
      const badgeColor = GRADE_COLOR[item.impact] || SLATE
      w.page.drawRectangle({ x: MARGIN, y: w.y - 14, width: 4, height: 14, color: rgb(badgeColor.r, badgeColor.g, badgeColor.b) })
      w.drawParagraph(section.toUpperCase(), { size: 6.8, color: SLATE, spaceAfter: 1 })
      w.drawParagraph(item.title + `  [${item.impact_label}]`, { font: w.bold, size: 10, color: NAVY, spaceAfter: 2 })
      w.drawParagraph(item.plain || plain(item.body), { size: 8.8, spaceAfter: 2, maxWidth: PAGE_W - MARGIN * 2 - 6 })
      if (item.source) {
        w.drawSourceLine('Source: ', item.source, item.source_url, { font: w.italic, size: 7.4, color: SLATE, spaceAfter: 8 })
      } else {
        w.y -= 8
      }
    }
  }

  // ---------- Watch List ----------
  if (vm.carry_forward?.length || (vm.sections || []).length) {
    const watchItems = vm.carry_forward || []
    if (watchItems.length) {
      w.newPage()
      w.drawParagraph('WATCH LIST — CARRIED FORWARD', { font: w.bold, size: 13, color: NAVY, spaceAfter: 10 })
      for (const it of watchItems) {
        w.drawParagraph(`• ${plain(it.title)}  (since W${it.since_week})`, { size: 9.3, spaceAfter: 4 })
      }
    }
  }

  return await w.doc.save()
}
