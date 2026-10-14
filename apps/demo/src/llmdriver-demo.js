import { LLMChain } from '@itookit/driver-llm/chain';
import { LLMDriver, testLLMConnection } from '@itookit/driver-llm';

// ============================================
// Example 1: Basic Usage with Built-in Providers
// ============================================

async function basicUsage() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4o-mini'
    });

    // Simple chat completion
    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const response = await client.chat.create({
        messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What is the capital of France?' }
        ]
    });

    console.log(response.choices[0].message.content);
}

// ============================================
// Example 2: Streaming Response
// ============================================

async function streamingExample() {
    const client = new LLMDriver({
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY
    });

    /** @type {AsyncGenerator<import('@itookit/driver-llm').ChatCompletionChunk>} */
    const stream = await client.chat.create({
        messages: [{ role: 'user', content: 'Write a short poem about AI' }],
        model: 'claude-3-5-sonnet-20241022',
        stream: true
    });

    console.log('Streaming response:');
    for await (const chunk of stream) {
        const content = chunk.choices[0]?.delta?.content;
        if (content) {
            process.stdout.write(content);
        }
    }
    console.log('\n');
}

// ============================================
// Example 3: Thinking Mode (Extended Reasoning)
// ============================================

async function thinkingModeExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY
    });

    // Non-streaming with thinking
    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const response = await client.chat.create({
        messages: [{ 
            role: 'user', 
            content: 'Solve this logic puzzle: If all roses are flowers and some flowers fade quickly, what can we conclude?' 
        }],
        model: 'gpt-4o',
        thinking: true, // Enable thinking mode
        maxTokens: 2000
    });

    console.log('Thinking:', response.choices[0].message.thinking);
    console.log('Answer:', response.choices[0].message.content);

    // Streaming with thinking
    console.log('\n--- Streaming with Thinking ---');
    /** @type {AsyncGenerator<import('@itookit/driver-llm').ChatCompletionChunk>} */
    const stream = await client.chat.create({
        messages: [{ role: 'user', content: 'Calculate 15% tip on $87.32' }],
        thinking: true,
        stream: true
    });

    let thinkingContent = '';
    let responseContent = '';

    for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.thinking) {
            thinkingContent += delta.thinking;
        }
        if (delta?.content) {
            responseContent += delta.content;
        }
    }

    console.log('Thinking Process:', thinkingContent);
    console.log('Final Answer:', responseContent);
}

// ============================================
// Example 4: Image/Document Attachments
// ============================================

async function attachmentsExample() {
    const client = new LLMDriver({
        provider: 'anthropic',
        apiKey: process.env.ANTHROPIC_API_KEY
    });

    // Image from URL
    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const imageResponse = await client.chat.create({
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'What do you see in this image?' },
                { 
                    type: 'image_url', 
                    image_url: { 
                        url: 'https://example.com/image.jpg' 
                    } 
                }
            ]
        }],
        model: 'claude-3-5-sonnet-20241022'
    });

    console.log(imageResponse.choices[0].message.content);

    // Base64 image
    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const base64Response = await client.chat.create({
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'Describe this chart' },
                { 
                    type: 'image_url',
                    image_url: { 
                        url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg...' 
                    }
                }
            ]
        }]
    });

    // PDF Document (Node.js with fs)
    // const fs = require('fs');
    // const pdfBuffer = fs.readFileSync('./document.pdf');
    // const { processAttachment } = require('@itookit/driver-llm');
    // const { base64, mimeType } = await processAttachment(pdfBuffer, 'application/pdf');
    
    // const pdfResponse = await client.chat.create({
    //     messages: [{
    //         role: 'user',
    //         content: [
    //             { type: 'text', text: 'Summarize this document' },
    //             { 
    //                 type: 'document',
    //                 document: { 
    //                     url: `data:${mimeType};base64,${base64}` 
    //                 }
    //             }
    //         ]
    //     }]
    // });
}

// ============================================
// Example 5: Custom Provider Configuration
// ============================================

async function customProviderExample() {
    // Define a new OpenAI-compatible provider
    /** @type {Record<string, import('@itookit/driver-llm').ProviderConfig>} */
    const myCustomProviders = {
        mycloud: {
            name: 'My Custom Cloud',
            implementation: 'openai-compatible', // Reuse existing implementation
            baseURL: 'https://api.mycloud.com/v1/chat/completions',
            supportsThinking: true,
            models: [
                { id: 'mycloud-pro', name: 'MyCloud Pro' },
                { id: 'mycloud-lite', name: 'MyCloud Lite' }
            ]
        },
        // Another custom provider
        mygemini: {
            name: 'Custom Gemini',
            implementation: 'gemini',
            baseURL: 'https://my-gemini-proxy.com/v1/models',
            models: [
                { id: 'custom-gemini-pro', name: 'Custom Gemini Pro' }
            ]
        }
    };

    const client = new LLMDriver({
        provider: 'mycloud',
        apiKey: 'MYCLOUD_API_KEY',
        model: 'mycloud-pro',
        customProviderDefaults: myCustomProviders
    });

    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const response = await client.chat.create({
        messages: [{ role: 'user', content: 'Hello from my custom provider!' }]
    });

    console.log(response.choices[0].message.content);
}

// ============================================
// Example 6: Advanced Options & Parameters
// ============================================

async function advancedOptionsExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        maxRetries: 5,        // Retry up to 5 times on failure
        retryDelay: 2000,     // Wait 2s between retries (exponential backoff)
        timeout: 30000        // 30 second timeout
    });

    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const response = await client.chat.create({
        messages: [{ role: 'user', content: 'Explain quantum computing' }],
        model: 'gpt-4o',
        temperature: 0.7,     // Control randomness (0-2)
        maxTokens: 500,       // Limit response length
        topP: 0.9,            // Nucleus sampling
        stream: false
    });

    console.log('Usage:', response.usage);
    console.log('Content:', response.choices[0].message.content);
}

// ============================================
// Example 7: Function Calling / Tools
// ============================================

async function functionCallingExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY
    });

    const tools = [
        {
            type: 'function',
            function: {
                name: 'get_weather',
                description: 'Get the current weather for a location',
                parameters: {
                    type: 'object',
                    properties: {
                        location: {
                            type: 'string',
                            description: 'City name, e.g., San Francisco'
                        },
                        unit: {
                            type: 'string',
                            enum: ['celsius', 'fahrenheit']
                        }
                    },
                    required: ['location']
                }
            }
        }
    ];

    /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
    const response = await client.chat.create({
        messages: [{ 
            role: 'user', 
            content: 'What\'s the weather in Tokyo?' 
        }],
        tools: tools,
        toolChoice: 'auto'
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (toolCall) {
        console.log('Function to call:', toolCall.function.name);
        console.log('Arguments:', toolCall.function.arguments);
    }
}

// ============================================
// Example 8: Request Lifecycle Hooks
// ============================================

async function hooksExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        hooks: {
            beforeRequest: async (params) => {
                console.log('🚀 Sending request to:', params.model);
                console.log('📝 Message count:', params.messages.length);
                // You can modify params here
                return params;
            },
            afterResponse: async (response) => {
                console.log('✅ Received response');
                console.log('📊 Tokens used:', response.usage?.total_tokens);
                // You can modify response here
                return response;
            },
            onError: async (/** @type {import('@itookit/driver-llm').LLMError} */ error, params) => {
                console.error('❌ Request failed:', error.message);
                console.error('🔧 Provider:', error.provider);
                console.error('📍 Status:', error.statusCode);
                // Log to monitoring service, etc.
            }
        }
    });

    try {
        await client.chat.create({
            messages: [{ role: 'user', content: 'Hello!' }]
        });
    } catch (error) {
        // Error already logged by onError hook
    }
}

// ============================================
// Example 9: Request Cancellation
// ============================================

async function cancellationExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY
    });

    const controller = new AbortController();

    // Cancel after 5 seconds
    setTimeout(() => {
        console.log('⏱️ Cancelling request...');
        controller.abort();
    }, 5000);

    try {
        await client.chat.create({
            messages: [{ role: 'user', content: 'Write a very long story...' }],
            signal: controller.signal
        });
    } catch (error) {
        if (error.name === 'AbortError') {
            console.log('✋ Request was cancelled');
        }
    }
}

// ============================================
// Example 10: Testing Connection
// ============================================

async function testConnectionExample() {
    const result = await testLLMConnection({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY,
        model: 'gpt-4o-mini'
    });

    if (result.success) {
        console.log('✅', result.message);
    } else {
        console.error('❌', result.message);
    }
}

// ============================================
// Example 11: LLM Chain (Sequential Processing)
// ============================================

async function chainExample() {
    const client = new LLMDriver({
        provider: 'openai',
        apiKey: process.env.OPENAI_API_KEY
    });

    const chain = new LLMChain(client);

    chain
        .add({
            promptTemplate: 'Generate a random topic about {theme}',
            inputVariables: ['theme'],
            outputVariable: 'topic'
        }, { model: 'gpt-4o-mini', maxTokens: 50 })
        .add({
            promptTemplate: 'Write a short paragraph about: {topic}',
            inputVariables: ['topic'],
            outputVariable: 'paragraph'
        }, { model: 'gpt-4o', maxTokens: 200 });

    const result = await chain.run({ theme: 'space exploration' });

    console.log('Topic:', result.topic);
    console.log('Paragraph:', result.paragraph);
}

// ============================================
// Example 12: Multi-Provider Comparison
// ============================================

async function multiProviderComparison() {
    const providers = [
        { name: 'OpenAI', provider: 'openai', model: 'gpt-4o-mini', key: process.env.OPENAI_API_KEY },
        { name: 'Anthropic', provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', key: process.env.ANTHROPIC_API_KEY },
        { name: 'Gemini', provider: 'gemini', model: 'gemini-1.5-flash', key: process.env.GEMINI_API_KEY }
    ];

    const question = 'What is the meaning of life in one sentence?';

    for (const config of providers) {
        const client = new LLMDriver({
            provider: config.provider,
            apiKey: config.key
        });

        console.log(`\n--- ${config.name} (${config.model}) ---`);
        
        /** @type {import('@itookit/driver-llm').ChatCompletionResponse} */
        const response = await client.chat.create({
            messages: [{ role: 'user', content: question }],
            model: config.model,
            maxTokens: 100
        });

        console.log(response.choices[0].message.content);
        console.log(`Tokens: ${response.usage?.total_tokens || 'N/A'}`);
    }
}

// ============================================
// Run Examples
// ============================================

async function runAllExamples() {
    console.log('=== Basic Usage ===');
    await basicUsage();

    console.log('\n=== Streaming ===');
    await streamingExample();

    console.log('\n=== Thinking Mode ===');
    await thinkingModeExample();

    console.log('\n=== Custom Provider ===');
    await customProviderExample();

    console.log('\n=== Advanced Options ===');
    await advancedOptionsExample();

    console.log('\n=== Function Calling ===');
    await functionCallingExample();

    console.log('\n=== Lifecycle Hooks ===');
    await hooksExample();

    console.log('\n=== Test Connection ===');
    await testConnectionExample();

    console.log('\n=== LLM Chain ===');
    await chainExample();

    console.log('\n=== Multi-Provider Comparison ===');
    await multiProviderComparison();
}

// Run specific example
// basicUsage();
// streamingExample();
// customProviderExample();

// Or run all examples
// runAllExamples();
