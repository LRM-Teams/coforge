import { createECDH, timingSafeEqual } from "node:crypto";

export function assertVapidKeyPair(publicKey: string, privateKey: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(privateKey, "base64url"));
  const expectedPublicKey = ecdh.getPublicKey();
  const configuredPublicKey = Buffer.from(publicKey, "base64url");
  if (
    expectedPublicKey.byteLength !== configuredPublicKey.byteLength ||
    !timingSafeEqual(expectedPublicKey, configuredPublicKey)
  ) {
    throw new Error("Web Push public and private keys do not match");
  }
}
