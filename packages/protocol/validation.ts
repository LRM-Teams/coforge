import { fromBinary, toBinary, type DescMessage, type MessageShape } from "@bufbuild/protobuf";
import { createValidator, ValidationError } from "@bufbuild/protovalidate";

const validator = createValidator();

export function validateMessage<D extends DescMessage>(schema: D, message: MessageShape<D>) {
  const result = validator.validate(schema, message);
  if (result.kind !== "valid") throw result.error;
  return message;
}

export function decodeValidated<D extends DescMessage>(schema: D, bytes: Uint8Array) {
  return validateMessage(schema, fromBinary(schema, bytes));
}

export function encodeValidated<D extends DescMessage>(schema: D, message: MessageShape<D>) {
  return toBinary(schema, validateMessage(schema, message));
}

export function formatValidationError(error: unknown): string {
  if (!(error instanceof ValidationError))
    return error instanceof Error ? error.message : "validation failed";
  return error.violations
    .map(
      ({ field, ruleId, message }) => `${field?.toString() ?? "<message>"}: ${message} (${ruleId})`,
    )
    .join("; ");
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}
