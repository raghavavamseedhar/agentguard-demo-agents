import express from 'express'
import OpenAI from 'openai'
import { AgentGuard } from '../agentguard-sdk'

const SYSTEM_PROMPT = `You are a Senior Fraud Investigator AI for Acme Bank's Financial Intelligence Unit (FIU).

Analyze the provided transaction information and return ONLY a valid JSON object — no markdown, no explanation outside JSON.

JSON schema:
{
  "risk_level": "HIGH" | "MEDIUM" | "LOW",
  "confidence": <integer 0-100>,
  "red_flags": [<specific indicator strings>],
  "pattern_summary": "<one sentence describing the pattern>",
  "recommended_action": "<specific next step>",
  "investigation_notes": "<2-3 sentences of expert analysis referencing specific details>",
  "regulatory_obligations": "<mandatory reporting requirements under UAE AML Law / CBUAE / FATF, or null if none>"
}

Apply UAE Federal Decree-Law No. 20/2018 on AML/CFT, CBUAE AML guidelines, and FATF 40 Recommendations.
Be specific — reference actual figures and dates from the input.`

function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim()
}

const app = express()
app.use(express.json())

app.post('/api/investigate', async (req, res) => {
  const { OPENAI_API_KEY, AGENTGUARD_API_KEY, AGENTGUARD_AGENT_ID } = process.env
  if (!OPENAI_API_KEY || !AGENTGUARD_API_KEY || !AGENTGUARD_AGENT_ID) {
    res.status(500).json({ error: 'Server not configured — check environment variables.' })
    return
  }

  const { description } = req.body as { description?: string }
  if (!description?.trim()) {
    res.status(400).json({ error: 'Transaction description is required.' })
    return
  }

  try {
    const guard = new AgentGuard({ apiKey: AGENTGUARD_API_KEY, agentId: AGENTGUARD_AGENT_ID })
    const openai = guard.wrapOpenAI(new OpenAI({ apiKey: OPENAI_API_KEY }))

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: description.trim() },
      ],
      max_tokens: 600,
      temperature: 0.2,
    })

    const raw = stripCodeFences(response.choices[0]?.message?.content ?? '{}')
    res.json(JSON.parse(raw))
  } catch (err) {
    console.error(err instanceof Error ? err.message : err)
    res.status(500).json({ error: 'Investigation failed. Please try again.' })
  }
})

export default app
