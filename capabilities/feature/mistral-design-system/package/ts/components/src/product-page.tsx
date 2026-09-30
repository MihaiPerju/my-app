import { Divider } from "@mistralai/ui/divider";
import { Flex } from "@mistralai/ui/flex";
import { Grid, type GridProps } from "@mistralai/ui/grid";
import { TypographyH1, TypographyH2, TypographyP } from "@mistralai/ui/typography";
import { type ComponentPropsWithoutRef, type ReactNode } from "react";

type ProductPageProps = {
  title: ReactNode;
  eyebrow?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  topBar?: ReactNode;
  children: ReactNode;
  panel?: ReactNode;
  sidebar?: ReactNode;
  contentWidth?: "centered" | "full";
  scrollable?: boolean;
};

type ProductSectionProps = ComponentPropsWithoutRef<"section"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  columns?: GridProps["columns"];
};

export function ProductPage({
  title,
  eyebrow,
  description,
  actions,
  topBar,
  children,
  panel,
  sidebar,
  contentWidth = "centered",
  scrollable = true,
}: ProductPageProps) {
  const widthClassName = contentWidth === "centered" ? "mx-auto max-w-screen-xl" : "w-full";

  return (
    <main
      className={`bg-default flex min-h-0 w-full flex-1 flex-col ${scrollable ? "overflow-y-auto" : "overflow-hidden"}`}
    >
      {topBar ? <div className="border-default bg-default border-b px-6 py-3">{topBar}</div> : null}

      <header className="border-default bg-canvas-card border-b px-6 py-8">
        <Flex
          className={widthClassName}
          direction={{ xs: "column", md: "row" }}
          justifyContent="between"
          alignItems={{ xs: "start", md: "center" }}
          gap={6}
        >
          <Flex direction="column" gap={3} className="min-w-0 max-w-3xl">
            {eyebrow ? (
              <TypographyP
                size="xs"
                weight="semibold"
                variant="muted"
                className="uppercase tracking-wider"
              >
                {eyebrow}
              </TypographyP>
            ) : null}
            <TypographyH1 size="4xl" weight="semibold">
              {title}
            </TypographyH1>
            {description ? (
              <TypographyP size="default" variant="muted">
                {description}
              </TypographyP>
            ) : null}
          </Flex>
          {actions ? (
            <Flex wrap="wrap" alignItems="center" gap={2} className="shrink-0">
              {actions}
            </Flex>
          ) : null}
        </Flex>
      </header>

      <Flex
        className={`${widthClassName} w-full flex-1 px-6 py-6`}
        direction={{ xs: "column", lg: "row" }}
        alignItems="start"
        gap={6}
      >
        {sidebar ? <aside className="min-w-0 shrink-0 lg:w-72">{sidebar}</aside> : null}
        <div className="min-w-0 flex-1">{children}</div>
        {panel ? <aside className="min-w-0 shrink-0 lg:w-80">{panel}</aside> : null}
      </Flex>
    </main>
  );
}

export function ProductSection({
  title,
  description,
  actions,
  columns = 1,
  children,
  className,
  ...props
}: ProductSectionProps) {
  const hasHeader = title || description || actions;

  return (
    <section
      className={`border-default bg-card rounded-card-lg border shadow-card ${className ?? ""}`}
      {...props}
    >
      {hasHeader ? (
        <>
          <Flex justifyContent="between" alignItems="start" gap={4} padding="lg">
            <Flex direction="column" gap={1} className="min-w-0">
              {title ? (
                <TypographyH2 size="lg" weight="semibold">
                  {title}
                </TypographyH2>
              ) : null}
              {description ? (
                <TypographyP size="sm" variant="muted">
                  {description}
                </TypographyP>
              ) : null}
            </Flex>
            {actions ? (
              <Flex wrap="wrap" gap={2} className="shrink-0">
                {actions}
              </Flex>
            ) : null}
          </Flex>
          <Divider />
        </>
      ) : null}
      <Grid columns={columns} gap={4} className="p-6">
        {children}
      </Grid>
    </section>
  );
}
