const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const axios = require('axios');

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

function messagesToPrompt(messages) {
    return messages.map((message) => {
        const role = message.role === 'assistant' ? 'Assistant' : message.role === 'system' ? 'System' : 'User';
        return `${role}: ${message.content}`;
    }).join('\n\n') + '\n\nAssistant:';
}

function extractResponsesText(data) {
    if (data.output_text) {
        return data.output_text;
    }

    const output = data.output || [];
    return output.flatMap(item => item.content || [])
        .map(content => content.text || content.value || '')
        .filter(Boolean)
        .join('\n')
        .trim();
}

async function callResponses(baseURL, apiKey, model, messages, temperature) {
    const response = await axios.post(`${baseURL}/responses`, {
        model: model,
        input: messages.map(message => ({
            role: message.role,
            content: message.content
        })),
        temperature: temperature
    }, {
        proxy: false,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    return { role: 'assistant', content: extractResponsesText(response.data) };
}

async function callTextCompletion(baseURL, apiKey, model, messages, temperature) {
    const response = await axios.post(`${baseURL}/completions`, {
        model: model,
        prompt: messagesToPrompt(messages),
        temperature: temperature
    }, {
        proxy: false,
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        }
    });
    const text = response.data.choices?.[0]?.text || response.data.choices?.[0]?.message?.content || '';
    return { role: 'assistant', content: text.trim() };
}

// Proxy endpoint for AI Chat
app.post('/api/chat', async (req, res) => {
    try {
        const { messages } = req.body;
        const provider = process.env.AI_PROVIDER || 'openai';
        const apiKey = process.env.AI_API_KEY;
        const model = process.env.AI_MODEL;
        const baseURL = (process.env.AI_BASE_URL || (provider === 'yunwu' ? 'https://yunwu.ai/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
        const endpoint = process.env.AI_ENDPOINT || (provider === 'yunwu' ? 'responses' : 'chat');
        const temperature = Number(process.env.AI_TEMPERATURE || 0.7);

        if (!apiKey) {
            return res.status(500).json({ error: 'API Key not configured on server' });
        }

        if (provider === 'openai' || provider === 'yunwu') {
            const selectedModel = model || (provider === 'yunwu' ? 'gpt-5.1' : 'gpt-3.5-turbo');
            if (endpoint === 'responses') {
                const response = await callResponses(baseURL, apiKey, selectedModel, messages, temperature);
                return res.json(response);
            }
            try {
                const response = await axios.post(`${baseURL}/chat/completions`, {
                    model: selectedModel,
                    messages: messages,
                    temperature: temperature
                }, {
                    proxy: false,
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    }
                });
                return res.json(response.data.choices[0].message);
            } catch (error) {
                const message = error.response?.data?.error?.message || '';
                if (provider === 'yunwu' && message.includes('not a chat model')) {
                    const completion = await callTextCompletion(baseURL, apiKey, selectedModel, messages, temperature);
                    return res.json(completion);
                }
                throw error;
            }
        } else if (provider === 'gemini') {
            const geminiModel = model || 'gemini-2.0-flash';
            const systemMsg = messages.find(m => m.role === 'system');
            const chatMessages = messages.filter(m => m.role !== 'system');
            const requestBody = {
                contents: chatMessages.map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }]
                }))
            };
            if (systemMsg) {
                requestBody.systemInstruction = { parts: [{ text: systemMsg.content }] };
            }
            const response = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${apiKey}`,
                requestBody,
                { proxy: false }
            );
            const text = response.data.candidates[0].content.parts[0].text;
            return res.json({ role: 'assistant', content: text });
        }

        res.status(400).json({ error: 'Unsupported AI provider' });
    } catch (error) {
        console.error('Chat error:', error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to fetch AI response' });
    }
});

module.exports = app;
