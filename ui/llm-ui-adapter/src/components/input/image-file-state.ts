import {randomUUID} from '@itookit/common';
import {DEFAULT_IMAGE_SPEC, validateSpec, type ImageSpec} from '@itookit/image-parser';

export interface ImageFileState {id: string; revision: number; original: File; spec: ImageSpec; resizeKey?: string}
const states = new WeakMap<File, ImageFileState>();
export function imageFileState(file: File): ImageFileState {
    let state = states.get(file);
    if (!state) {state = {id: randomUUID(), revision: 0, original: file, spec: DEFAULT_IMAGE_SPEC}; states.set(file, state);}
    return state;
}
export function setImageFileState(file: File, state: ImageFileState): void {
    states.set(file, {...state, spec: validateSpec(state.spec)});
}
export function knownImageFileState(file: File): ImageFileState | undefined {return states.get(file);}
