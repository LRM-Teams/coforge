/** The error a call rejected with, so a test can assert on the whole sentence a person reads
 * rather than only the fragment `toThrow` matches. Fails the test if the call resolves. */
export async function rejection(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, got ${String(error)}`);
  }
  throw new Error("expected the call to reject");
}
