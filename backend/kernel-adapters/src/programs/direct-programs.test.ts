import { expect, it } from 'vitest';
import type { TaskInputEvent } from '@itookit/durable-kernel';
import { ToolProgram } from './tool-program';
import { MediaProgram } from './media-program';

it('keeps direct Tool and media Tasks waiting when dependency events arrive before capability grants', () => {
    const dependency = { type: 'task-exited', taskId: 'upstream', exit: { status: 'succeeded', output: {} } } as TaskInputEvent;
    const tool = new ToolProgram();
    const toolState = tool.init({ toolId: 'convert', toolVersion: '1', args: {}, allowedToolIds: ['convert'], approval: 'none' }).state;
    expect(tool.reduce(toolState, dependency).next).toEqual({ type: 'wait', on: { type: 'signal', id: 'capabilities' } });
    const media = new MediaProgram();
    const mediaState = media.init({ connectionId: 'images', request: { operation: 'image.generate', model: 'fixture', prompt: 'square', format: 'png' } }).state;
    expect(media.reduce(mediaState, dependency).next).toEqual({ type: 'wait', on: { type: 'signal', id: 'capabilities' } });
    const signal = { type: 'signal', signal: { type: 'capabilities', payload: { toolHandleId: 'tool', llmHandleId: 'llm' } } } as TaskInputEvent;
    expect(tool.reduce(toolState, signal).actions).toHaveLength(1);
    expect(media.reduce(mediaState, signal).actions).toHaveLength(1);
});
