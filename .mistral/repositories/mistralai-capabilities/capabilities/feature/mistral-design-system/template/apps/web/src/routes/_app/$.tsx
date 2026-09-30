import { EmptyState } from "@mistralai-capabilities/feature-mistral-design-system/components";
import { CompassIcon } from "@phosphor-icons/react";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";

/**
 * Any URL no page claims, rendered inside the shell rather than as the router's bare fallback. The
 * loader throws `notFound()` rather than rendering a page, so the server answers 404, and this
 * route's own `notFoundComponent` shows the page in the shell's outlet.
 *
 * It is also what keeps the `_app` layout non-empty in an app whose capabilities add no page of
 * their own: a pathless layout with no child route collides with `/` and fails the build. It has no
 * `nav` entry, so it never shows in the sidebar.
 */
export const Route = createFileRoute("/_app/$")({
  loader: () => {
    throw notFound();
  },
  notFoundComponent: NotFoundPage,
});

function NotFoundPage() {
  return (
    <div className="mx-auto flex min-h-full max-w-xl flex-col justify-center p-8">
      <EmptyState
        icon={<CompassIcon className="size-8" />}
        title="Page not found"
        description="Nothing lives at this address."
        action={
          <Link to="/" className="text-default text-sm font-medium underline underline-offset-4">
            Go to the home page
          </Link>
        }
      />
    </div>
  );
}
