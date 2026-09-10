import { useState } from "react";
import {
  Check,
  Laptop01 as Laptop,
  ShieldZap as ShieldAlert,
  XClose as X,
} from "@untitledui/icons";

import { Button } from "@/components/base/buttons/button";
import { HintText } from "@/components/base/input/hint-text";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { m } from "@/paraglide/messages";
import { formatUserCode, USER_CODE_LENGTH } from "./device-code-format";
import {
  approveDeviceCode,
  checkDeviceCode,
  denyDeviceCode,
  type DeviceCodeState,
} from "./device-auth.functions";

type Stage =
  | { name: "entry" }
  | { name: "confirm"; code: string }
  | { name: "approved" }
  | { name: "denied" };

/** The generated alphabet plus the lowercase a user may type - the field uppercases as it goes,
 * but `pattern` is applied to the raw keystroke, so it has to admit both cases. Digits 0/1 and
 * letters I/L/O/U are absent from the alphabet on purpose (see device-auth.server.ts) and are
 * refused here too, rather than accepted and then reported back as an unknown code. */
const CODE_PATTERN = "[BCDFGHJKMNPQRSTVWXYZbcdfghjkmnpqrstvwxyz23456789]*";

function problemMessage(state: DeviceCodeState): string | null {
  if (state === "unknown") return m.device_verify_unknown();
  if (state === "expired") return m.device_verify_expired();
  if (state === "settled") return m.device_verify_settled();
  if (state === "unavailable") return m.device_verify_unavailable();
  return null;
}

export function DeviceVerifyPage({ email, initialCode }: { email: string; initialCode: string }) {
  const [code, setCode] = useState(initialCode);
  const [stage, setStage] = useState<Stage>({ name: "entry" });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const complete = code.length === USER_CODE_LENGTH;

  async function submitCode(value: string = code) {
    if (busy || value.length !== USER_CODE_LENGTH) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = await checkDeviceCode({ data: { userCode: value } });
      if (result.state === "ok") setStage({ name: "confirm", code: value });
      else setProblem(problemMessage(result.state));
    } finally {
      setBusy(false);
    }
  }

  async function settle(approve: boolean) {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const result = approve
        ? await approveDeviceCode({ data: { userCode: code } })
        : await denyDeviceCode({ data: { userCode: code } });
      if (result.state === "ok") setStage(approve ? { name: "approved" } : { name: "denied" });
      else {
        setProblem(problemMessage(result.state));
        setStage({ name: "entry" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-svh items-center justify-center bg-primary px-4 py-16 sm:px-6">
      <div className="w-full max-w-md">
        {stage.name === "approved" || stage.name === "denied" ? (
          <Settled approved={stage.name === "approved"} />
        ) : (
          <>
            <div
              className={`mx-auto mb-6 flex size-14 items-center justify-center rounded-xl shadow-xs ${
                stage.name === "confirm"
                  ? "bg-primary text-brand-secondary ring-1 ring-brand"
                  : "bg-primary text-primary ring-1 ring-secondary"
              }`}
            >
              {stage.name === "confirm" ? (
                <ShieldAlert className="size-7" aria-hidden="true" />
              ) : (
                <Laptop className="size-7" aria-hidden="true" />
              )}
            </div>

            <h1 className="text-center text-display-xs font-semibold text-primary">
              {stage.name === "confirm" ? m.device_verify_confirm_title() : m.device_verify_title()}
            </h1>
            <p className="mt-2 text-center text-sm text-tertiary">
              {stage.name === "confirm"
                ? m.device_verify_confirm_description({ code: formatUserCode(stage.code) })
                : m.device_verify_description()}
            </p>

            {stage.name === "entry" ? (
              <div className="mt-8">
                <div className="flex justify-center">
                  <InputOTP
                    containerClassName="gap-2"
                    maxLength={USER_CODE_LENGTH}
                    value={code}
                    pattern={CODE_PATTERN}
                    // The code is displayed uppercase everywhere, so both entry paths normalize:
                    // typing through onChange, and a pasted `xxxx-xxxx` through pasteTransformer,
                    // which also drops the dash the code is displayed with.
                    pasteTransformer={(pasted: string) =>
                      pasted.replace(/[\s-]/g, "").toUpperCase()
                    }
                    onChange={(next: string) => {
                      setCode(next.toUpperCase());
                      setProblem(null);
                    }}
                    // Firing on completion is what makes a pasted code need no second action.
                    onComplete={submitCode}
                    disabled={busy}
                    aria-label={m.device_verify_code_label()}
                    aria-invalid={problem !== null || undefined}
                    autoFocus
                  >
                    <InputOTPGroup className="gap-1 sm:gap-2">
                      {[0, 1, 2, 3].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="h-12 w-7 text-lg sm:h-14 sm:w-10 sm:text-xl"
                        />
                      ))}
                    </InputOTPGroup>
                    <InputOTPSeparator />
                    <InputOTPGroup className="gap-1 sm:gap-2">
                      {[4, 5, 6, 7].map((index) => (
                        <InputOTPSlot
                          key={index}
                          index={index}
                          className="h-12 w-7 text-lg sm:h-14 sm:w-10 sm:text-xl"
                        />
                      ))}
                    </InputOTPGroup>
                  </InputOTP>
                </div>
                {problem ? (
                  <HintText isInvalid role="alert" className="mt-4 text-center">
                    {problem}
                  </HintText>
                ) : null}
                <Button
                  type="button"
                  size="lg"
                  className="mt-6 w-full"
                  isDisabled={busy || !complete}
                  onPress={() => submitCode()}
                >
                  {busy ? m.device_verify_checking() : m.device_verify_continue()}
                </Button>
              </div>
            ) : (
              <div className="mt-8 flex gap-3">
                <Button
                  type="button"
                  color="secondary"
                  size="lg"
                  className="flex-1"
                  isDisabled={busy}
                  onPress={() => settle(false)}
                >
                  {m.device_verify_deny()}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  className="flex-1"
                  isDisabled={busy}
                  onPress={() => settle(true)}
                >
                  {m.device_verify_approve()}
                </Button>
              </div>
            )}

            <p className="mt-8 text-center text-sm break-words text-tertiary">
              {m.device_verify_signed_in_as({ email })}
            </p>
          </>
        )}
      </div>
    </main>
  );
}

function Settled({ approved }: { approved: boolean }) {
  return (
    <div className="py-2 text-center">
      <div
        className={`mx-auto flex size-14 items-center justify-center rounded-full ring-8 ${
          approved
            ? "bg-success-primary text-success-primary ring-utility-green-100"
            : "bg-secondary text-tertiary ring-secondary"
        }`}
      >
        {approved ? (
          <Check className="size-7" aria-hidden="true" />
        ) : (
          <X className="size-7" aria-hidden="true" />
        )}
      </div>
      <h1 className="mt-6 text-display-xs font-semibold text-primary">
        {approved ? m.device_verify_approved_title() : m.device_verify_denied_title()}
      </h1>
      <p className="mt-2 text-sm text-tertiary">
        {approved ? m.device_verify_approved_description() : m.device_verify_denied_description()}
      </p>
    </div>
  );
}
