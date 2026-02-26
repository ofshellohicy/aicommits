import http from 'http';
import https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import type {
	CreateChatCompletionRequest,
	CreateChatCompletionResponse,
} from 'openai';
// import {
// 	type TiktokenModel,
// 	// encoding_for_model,
// } from '@dqbd/tiktoken';
import createHttpsProxyAgent from 'https-proxy-agent';
import { KnownError } from './error.js';
import type { CommitType } from './config.js';
import { generatePrompt } from './prompt.js';

const post = async (
	protocol: 'http' | 'https',
	hostname: string,
	port: number,
	path: string,
	headers: Record<string, string>,
	json: unknown,
	timeout: number,
	proxy?: string
) =>
	new Promise<{
		request: ClientRequest;
		response: IncomingMessage;
		data: string;
	}>((resolve, reject) => {
		const postContent = JSON.stringify(json);
		const client = protocol === 'https' ? https : http;
		const request = client.request(
			{
				hostname,
				port,
				path,
				method: 'POST',
				headers: {
					...headers,
					'Content-Type': 'application/json',
					'Content-Length': Buffer.byteLength(postContent),
				},
				timeout,
				agent: protocol === 'https' && proxy ? createHttpsProxyAgent(proxy) : undefined,
			},
			(response) => {
				const body: Buffer[] = [];
				response.on('data', (chunk) => body.push(chunk));
				response.on('end', () => {
					resolve({
						request,
						response,
						data: Buffer.concat(body).toString(),
					});
				});
			}
		);
		request.on('error', reject);
		request.on('timeout', () => {
			request.destroy();
			reject(
				new KnownError(
					`Time out error: request host: ${hostname}:${port}${path} took over ${timeout}ms. Try increasing the \`timeout\` config, or checking the OpenAI API status https://status.openai.com`
				)
			);
		});

		request.write(postContent);
		request.end();
	});

const createChatCompletion = async (
	apiKey: string,
	json: CreateChatCompletionRequest,
	timeout: number,
	proxy?: string,
	host?: string,
	base_url?: string
) => {
	// console.log('apiKey', apiKey);
	// console.log('json', json);
	// console.log('timeout', timeout);
	// console.log('proxy', proxy);
	let path = '/v1/chat/completions';
	let protocol: 'http' | 'https' = 'https';
	let port = 443;
	if (base_url) {
		const urlObj = new URL(base_url);
		host = urlObj.hostname;
		path = urlObj.pathname.replace(/\/$/, '') + '/chat/completions';
		protocol = urlObj.protocol === 'http:' ? 'http' : 'https';
		port = urlObj.port ? parseInt(urlObj.port, 10) : protocol === 'https' ? 443 : 80;
		console.log("AICOMMIT ENV START ====");
		console.log('base_url', base_url);
		console.log('host', host);
		console.log('path', path);
		console.log("AICOMMIT ENV END ====");
	}
	const { response, data } = await post(
		protocol,
		host || 'api.openai.com',
		port,
		path,
		{
			Authorization: `Bearer ${apiKey}`,
		},
		json,
		timeout,
		proxy,
	);

	if (
		!response.statusCode ||
		response.statusCode < 200 ||
		response.statusCode > 299
	) {
		// let errorMessage = `OpenAI API Error: ${response.statusCode} - ${response.statusMessage}`;
		let errorMessage = `DeepSeek API Error: ${response.statusCode} - ${response.statusMessage}, host: ${host}, apiKey: ${apiKey}`;

		if (data) {
			errorMessage += `\n\n${data}`;
		}

		if (response.statusCode === 500) {
			errorMessage += '\n\nCheck the API status: https://status.deepseek.com';
		}

		throw new KnownError(errorMessage);
	}

	return JSON.parse(data) as CreateChatCompletionResponse;
};

// Strip think blocks from models that output reasoning (e.g. MiniMax with thinking).
const stripThinkBlocks = (message: string) =>
	message.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

const sanitizeMessage = (message: string) =>
	stripThinkBlocks(message)
		.replace(/[\n\r]/g, '')
		.replace(/(\w)\.$/, '$1');

const deduplicateMessages = (array: string[]) => Array.from(new Set(array));

// const generateStringFromLength = (length: number) => {
// 	let result = '';
// 	const highestTokenChar = 'z';
// 	for (let i = 0; i < length; i += 1) {
// 		result += highestTokenChar;
// 	}
// 	return result;
// };

// const getTokens = (prompt: string, model: TiktokenModel) => {
// 	const encoder = encoding_for_model(model);
// 	const tokens = encoder.encode(prompt).length;
// 	// Free the encoder to avoid possible memory leaks.
// 	encoder.free();
// 	return tokens;
// };

export const generateCommitMessage = async (
	apiKey: string,
	// model: TiktokenModel,
	model: any,
	locale: string,
	diff: string,
	completions: number,
	maxLength: number,
	type: CommitType,
	timeout: number,
	proxy?: string,
	host?: string,
	base_url?: string
) => {
	try {
		const completion = await createChatCompletion(
			apiKey,
			{
				model,
				messages: [
					{
						role: 'system',
						content: generatePrompt(locale, maxLength, type),
					},
					{
						role: 'user',
						content: diff,
					},
				],
				temperature: 0.7,
				top_p: 1,
				frequency_penalty: 0,
				presence_penalty: 0,
				max_tokens: 200,
				stream: false,
				// n: completions,
				n: 1,
			},
			timeout,
			proxy,
			host,
			base_url
		);

		return deduplicateMessages(
			completion.choices
				.filter((choice) => choice.message?.content)
				.map((choice) => sanitizeMessage(choice.message!.content as string))
		);
	} catch (error) {
		const errorAsAny = error as any;
		if (errorAsAny.code === 'ENOTFOUND') {
			throw new KnownError(
				`Error connecting to ${errorAsAny.hostname} (${errorAsAny.syscall}). Are you connected to the internet?`
			);
		}

		throw errorAsAny;
	}
};
