import type { RequestHandler } from './$types';

import { env } from '$env/dynamic/private';

import { AssistantResponse } from 'ai';
import OpenAI from 'openai';
import { ASSISTANT_ID } from '$lib/config';
import { addMessageToDb } from '$lib/services/db.server';

const openai = new OpenAI({
	apiKey: env.OPENAI_API_KEY || ''
});

export const POST = (async ({ request }) => {
	// Parse the request body
	const input: {
		threadId: string | null;
		message: string;
	} = await request.json();

	// Create a thread if needed
	const threadId = input.threadId ?? (await openai.beta.threads.create({})).id;

	// Add a message to the thread
	const createdMessage = await openai.beta.threads.messages.create(threadId, {
		role: 'user',
		content: input.message
	});
	// add user message to db
	await addMessageToDb(threadId, input.message, 'user');

	return AssistantResponse(
		{ threadId, messageId: createdMessage.id },
		async ({ forwardStream, sendDataMessage }) => {
			// Run the assistant on the thread
			const runStream = openai.beta.threads.runs
				.stream(threadId, {
					assistant_id:
						ASSISTANT_ID ??
						(() => {
							throw new Error('ASSISTANT_ID is not set');
						})()
				})
				// add assistant message to db
				.on('textDone', (content) => {
					addMessageToDb(threadId, content.value, 'asst');
				});

			// forward run status would stream message deltas
			let runResult = await forwardStream(runStream);

			// status can be: queued, in_progress, requires_action, cancelling, cancelled, failed, completed, or expired
			while (
				runResult?.status === 'requires_action' &&
				runResult.required_action?.type === 'submit_tool_outputs'
			) {
				const tool_outputs = runResult.required_action.submit_tool_outputs.tool_calls.map(
					(toolCall: any) => {
						const parameters = JSON.parse(toolCall.function.arguments);

						switch (toolCall.function.name) {
							// configure your tool calls here

							default:
								throw new Error(`Unknown tool call function: ${toolCall.function.name}`);
						}
					}
				);

				runResult = await forwardStream(
					openai.beta.threads.runs.submitToolOutputsStream(threadId, runResult.id, { tool_outputs })
				);
			}
		}
	);
}) satisfies RequestHandler;