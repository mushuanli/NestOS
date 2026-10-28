import {SchemaForm as SharedSchemaForm, validateSchema as validateSharedSchema, type JsonSchema} from '@itookit/llm-ui/forms';
import type {FormLayout, JsonValue} from '@itookit/llm-flow/contracts';

/** Flow expression acceptance is host policy; field rendering and parsing are shared. */
const expression = (value: JsonValue) => typeof value === 'string' && /^\$\{(?:param|params|nodes|state|iteration|vars)\.([A-Za-z0-9_./-]+)\}$/.test(value.trim());
export class SchemaForm extends SharedSchemaForm {
    constructor(root: HTMLElement, schema: JsonValue, value: JsonValue, layout?: FormLayout) {
        super(root, schema, value, {layout, acceptValue: expression});
    }
}
export function validateSchema(schema: JsonSchema, value: JsonValue, path = '$'): string[] {
    return validateSharedSchema(schema, value, path, {acceptValue: expression});
}
