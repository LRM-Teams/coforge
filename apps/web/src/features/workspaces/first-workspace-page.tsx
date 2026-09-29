import { Button } from "#src/components/base/buttons/button";
import { AuthSplitLayout } from "#src/features/auth/auth-split-layout";
import { m } from "#src/paraglide/messages";
import {
  CreateWorkspaceForm,
  useCreateAndOpenWorkspace,
} from "#src/features/workspaces/create-workspace-form";

/**
 * Where a signed-in person in no Workspace (they left or deleted their last one) lands: create one
 * and open it, or sign out. Creating it also makes it the Workspace `/` opens.
 */
export function FirstWorkspacePage({ viewerEmail }: { viewerEmail: string }) {
  const createAndOpen = useCreateAndOpenWorkspace();
  return (
    <AuthSplitLayout>
      <div className="flex w-full flex-col gap-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <img src="/logo.svg" alt="" className="size-12" />
          <div className="flex flex-col gap-2 md:gap-3">
            <h1 className="text-display-xs font-semibold text-primary md:text-display-sm">
              {m.workspace_first_title()}
            </h1>
            <p className="text-md text-tertiary">{m.workspace_first_description()}</p>
          </div>
        </div>
        <CreateWorkspaceForm
          onCreate={createAndOpen}
          fieldsClassName="grid gap-4"
          actions={(submit) => <Button {...submit} size="lg" className="mt-6 w-full" />}
        />
        <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-center text-xs text-quaternary">
          <span className="break-all">{m.workspace_join_signed_in_as({ email: viewerEmail })}</span>
          <span aria-hidden="true">·</span>
          {/* Signing out goes through Authing and lands on the homepage. */}
          <Button href="/auth/logout" color="link-gray" size="sm">
            {m.controls_sign_out()}
          </Button>
        </p>
      </div>
    </AuthSplitLayout>
  );
}
