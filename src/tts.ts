// Port of modules.py's TTS support. On Cloudflare Workers there is no `gsk`
// CLI, so narration calls the Gemini TTS API directly (generativelanguage
// API) using GEMINI_API_KEY. Caching moves from a local file (data/audio/)
// to R2, keyed the same way (voice + text hash).

export const VOICES = [
  { id: 'Charon', label: 'Charon — informative, measured (default)' },
  { id: 'Kore', label: 'Kore — firm, authoritative' },
  { id: 'Iapetus', label: 'Iapetus — clear, crisp' },
  { id: 'Algieba', label: 'Algieba — smooth, warm' },
  { id: 'Umbriel', label: 'Umbriel — easy-going' },
  { id: 'Autonoe', label: 'Autonoe — bright' },
]

const VOICE_IDS = new Set(VOICES.map((v) => v.id))

const DIRECTION = `# AUDIO PROFILE: Maya
## "The Executive Briefer"
## THE SCENE: A quiet boardroom before market open. A senior analyst reads the weekly industry brief aloud to the chief executive, who is listening while reviewing the numbers.
### DIRECTOR'S NOTES
Style: Composed, authoritative, neutral newsreader warmth. Credible and calm. No hype, no salesmanship, no upspeak.
Pacing: Measured and even. Clear separation between sentences so figures land. A short beat before each new section heading.
Accent: Neutral international English.
### SAMPLE CONTEXT
This is the voice used for institutional market-open briefings.
#### TRANSCRIPT
`

// Make written brief prose read naturally aloud.
// The brief is written for the eye: "RM 1.5 bn", "+7.80% wow", "USD 96.28/bbl".
// Read literally those come out as gibberish, so expand them.
export function spokenText(text: string): string {
  let t = (text || '').replace(/<[^>]+>/g, ' ')
  t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, 'and')
  const repl: [RegExp, string][] = [
    [/\bwow\b/g, 'week on week'],
    [/\bmom\b/g, 'month on month'],
    [/\byoy\b/g, 'year on year'],
    [/\bRM\s*([\d.,]+)\s*bn\b/g, '$1 billion ringgit'],
    [/\bRM\s*([\d.,]+)\s*m\b/g, '$1 million ringgit'],
    [/\bRM\s*([\d.,]+)/g, '$1 ringgit'],
    [/\bUSD\s*([\d.,]+)\s*\/\s*bbl\b/g, '$1 US dollars per barrel'],
    [/\bUSD\s*([\d.,]+)/g, '$1 US dollars'],
    [/([\d.]+)\s*%/g, '$1 percent'],
    [/\bbps\b/g, 'basis points'],
    [/\bppt\b/g, 'percentage points'],
    [/\bQ([1-4])\b/g, 'quarter $1'],
    [/\bH([12])\b/g, 'half $1'],
    [/\bFY(\d{2})\b/g, 'financial year 20$1'],
    [/\bFY(\d{4})\b/g, 'financial year $1'],
    [/\be\.g\./g, 'for example'],
    [/\bi\.e\./g, 'that is'],
    [/\bvs\.(?=\s)/g, 'versus'],
    [/\bvs\b/g, 'versus'],
    [/\bNo\.\s/g, 'number '],
    [/\s+/g, ' '],
  ]
  for (const [pat, rep] of repl) t = t.replace(pat, rep)
  return t.trim()
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function ttsCacheKey(text: string, voice: string): Promise<string> {
  const h = (await sha256Hex(voice + '|' + text)).slice(0, 20)
  return `audio/${voice}-${h}.mp3`
}

export interface SynthesiseResult {
  key: string
  error: string | null
}

// Generate narration via the Gemini TTS REST API and cache the wav in R2.
export async function synthesise(
  r2: R2Bucket,
  apiKey: string | undefined,
  text: string,
  voice = 'Kore',
): Promise<SynthesiseResult> {
  const spoken = spokenText(text)
  if (!spoken) return { key: '', error: 'nothing to read' }
  const clipped = spoken.slice(0, 4000)
  const v = VOICE_IDS.has(voice) ? voice : 'Kore'
  const key = await ttsCacheKey(clipped, v)

  const existing = await r2.head(key)
  if (existing && existing.size > 1000) return { key, error: null }

  if (!apiKey) {
    return { key: '', error: 'Narration is not configured — set the GEMINI_API_KEY secret to enable read-aloud.' }
  }

  const prompt = DIRECTION + clipped
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        // Single-speaker narration uses voiceConfig directly — NOT
        // multiSpeakerVoiceConfig, which the API rejects unless it is
        // given exactly 2 speaker_voice_configs (400 INVALID_ARGUMENT).
        voiceConfig: { prebuiltVoiceConfig: { voiceName: v } },
      },
    },
  }

  const model = 'gemini-3.1-flash-tts-preview'
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  let resp: Response
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    return { key: '', error: `tts request failed: ${(e as Error).message}` }
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '')
    return { key: '', error: `tts failed: ${errText.slice(0, 300)}` }
  }

  const data = await resp.json<any>()
  const inlineData = data?.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData)?.inlineData
  if (!inlineData?.data) {
    return { key: '', error: 'tts failed: no audio in response' }
  }

  // Gemini TTS returns raw PCM (audio/L16 @ 24kHz by default) base64-encoded.
  // Wrap it in a minimal WAV header so browsers can play it directly.
  const pcm = base64ToBytes(inlineData.data)
  const wav = pcmToWav(pcm, 24000, 1, 16)

  await r2.put(key, wav, { httpMetadata: { contentType: 'audio/wav' } })
  return { key, error: null }
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

function pcmToWav(pcm: Uint8Array, sampleRate: number, channels: number, bitsPerSample: number): Uint8Array {
  const blockAlign = channels * (bitsPerSample / 8)
  const byteRate = sampleRate * blockAlign
  const buffer = new ArrayBuffer(44 + pcm.length)
  const view = new DataView(buffer)
  const writeStr = (offset: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)) }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeStr(36, 'data')
  view.setUint32(40, pcm.length, true)
  const out = new Uint8Array(buffer)
  out.set(pcm, 44)
  return out
}
