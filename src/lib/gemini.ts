import { GoogleGenAI } from '@google/genai';

export async function analyzePdfStream(
  apiKey: string,
  model: string,
  base64: string,
  prompt: string,
  onChunk: (text: string) => void
): Promise<void> {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContentStream({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'application/pdf', data: base64 } },
        ],
      },
    ],
  });

  for await (const chunk of response) {
    if (chunk.text) onChunk(chunk.text);
  }
}
