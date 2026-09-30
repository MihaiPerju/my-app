"use client";

import {
  CaretLeftIcon,
  CaretRightIcon,
  MinusIcon,
  PlusIcon,
  ScanIcon,
} from "@phosphor-icons/react";
import { type ChangeEvent, type KeyboardEvent, useState } from "react";

import { Button } from "@mistralai/ui/button";
import { Input } from "@mistralai/ui/input";

import type { PdfViewerToolbarLabels } from "./types";

export type { PdfViewerToolbarLabels };

export interface PdfViewerToolbarProps {
  currentPage: number;
  pagesCount: number;
  onPageChange: (page: number) => void;
  zoom: number;
  maxZoom: number;
  onZoomChange: (zoom: number) => void;
  showDetectedRegions: boolean;
  onToggleDetectedRegions: () => void;
  hasDetectedRegions: boolean;
  labels: PdfViewerToolbarLabels;
}

function blurOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
  if (event.key === "Enter") {
    event.currentTarget.blur();
  }
}

export function PdfViewerToolbar({
  currentPage,
  pagesCount,
  onPageChange,
  zoom,
  maxZoom,
  onZoomChange,
  showDetectedRegions,
  onToggleDetectedRegions,
  hasDetectedRegions,
  labels,
}: PdfViewerToolbarProps) {
  const hasPrevious = currentPage > 1;
  const hasNext = pagesCount && currentPage < pagesCount;

  const goToPreviousPage = () => {
    if (hasPrevious) {
      onPageChange(currentPage - 1);
    }
  };

  const goToNextPage = () => {
    if (hasNext) {
      onPageChange(currentPage + 1);
    }
  };

  return (
    <div className="shadow-basic-black grid h-12 w-full shrink-0 grid-cols-[1fr_auto_1fr] items-center justify-center gap-4 bg-(--zinc-800) shadow-md">
      <div className="col-start-2 flex">
        <div className="flex items-center">
          <Button
            isDisabled={!hasPrevious}
            variant="ghost-muted"
            size="xs"
            onClick={goToPreviousPage}
            mode="icon-only"
            icon={CaretLeftIcon}
            aria-label={labels.previousPage}
            className="aria-disabled:text-icon-inverted-disabled"
          />
          <PageInput
            currentPage={currentPage}
            pagesCount={pagesCount}
            onPageChange={onPageChange}
            ariaLabel={labels.pageNumber}
          />
          <span className="text-inverted-muted ms-2 text-sm">/ {pagesCount}</span>
          <Button
            isDisabled={!hasNext}
            variant="ghost-muted"
            size="xs"
            onClick={goToNextPage}
            mode="icon-only"
            icon={CaretRightIcon}
            aria-label={labels.nextPage}
            className="aria-disabled:text-icon-inverted-disabled"
          />
        </div>

        <div className="flex items-center gap-1">
          <ZoomInput
            zoom={zoom}
            maxZoom={maxZoom}
            onZoomChange={onZoomChange}
            labels={{
              zoomIn: labels.zoomIn,
              zoomOut: labels.zoomOut,
              zoomLevel: labels.zoomLevel,
            }}
          />
        </div>
      </div>

      {hasDetectedRegions && (
        <Button
          variant="ghost-muted"
          size="xs"
          onClick={onToggleDetectedRegions}
          mode="icon-only"
          icon={ScanIcon}
          aria-label={showDetectedRegions ? labels.hideDetectedRegions : labels.showDetectedRegions}
          title={showDetectedRegions ? labels.hideDetectedRegions : labels.showDetectedRegions}
          className="aria-disabled:text-icon-inverted-disabled me-4 justify-self-end"
        />
      )}
    </div>
  );
}

interface PageInputProps {
  currentPage: number;
  pagesCount: number;
  onPageChange: (page: number) => void;
  ariaLabel: string;
}

function PageInput({ currentPage, pagesCount, onPageChange, ariaLabel }: PageInputProps) {
  const [localValue, setLocalValue] = useState(String(currentPage));
  const [isFocused, setIsFocused] = useState(false);

  // When not focused, always reflect the current page from props
  const displayValue = isFocused ? localValue : String(currentPage);

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
  };

  const handleFocus = () => {
    setLocalValue(String(currentPage));
    setIsFocused(true);
  };

  const navigateToPage = () => {
    setIsFocused(false);
    const pageNum = parseInt(localValue, 10);
    if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= pagesCount) {
      onPageChange(pageNum);
    }
  };

  return (
    <Input
      isDisabled={pagesCount < 2}
      size="sm"
      type="number"
      min={1}
      max={pagesCount}
      value={displayValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onKeyDown={blurOnEnter}
      onBlur={navigateToPage}
      aria-label={ariaLabel}
      name="page-number"
      className="border-inverted/50 hover:border-inverted/60 text-white-default h-6 w-9 [appearance:textfield] rounded-sm bg-(--transparent-light-4) p-0 text-center text-sm hover:bg-(--transparent-light-8) [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
    />
  );
}

interface ZoomInputProps {
  zoom: number;
  maxZoom: number;
  onZoomChange: (zoom: number) => void;
  labels: { zoomIn: string; zoomOut: string; zoomLevel: string };
}

const MIN_ZOOM = 25;
const ZOOM_PRESETS = [25, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500];

function ZoomInput({ zoom, maxZoom, onZoomChange, labels }: ZoomInputProps) {
  const effectiveMaxZoom = Math.min(maxZoom, ZOOM_PRESETS[ZOOM_PRESETS.length - 1]!);
  const availableZoomPresets = ZOOM_PRESETS.filter((zoomPreset) => zoomPreset <= effectiveMaxZoom);
  const [localValue, setLocalValue] = useState(String(zoom));
  const [isFocused, setIsFocused] = useState(false);

  // When not focused, always reflect the zoom from props
  const displayValue = isFocused ? localValue : `${zoom}%`;

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value);
  };

  const handleFocus = () => {
    // Remove % suffix when focused for easier editing
    setLocalValue(String(zoom));
    setIsFocused(true);
  };

  const applyZoom = () => {
    setIsFocused(false);
    // Strip % suffix if present and parse
    const cleanValue = localValue.replace(/%$/, "");
    const zoomValue = parseInt(cleanValue, 10);
    if (!isNaN(zoomValue) && zoomValue >= MIN_ZOOM && zoomValue <= effectiveMaxZoom) {
      onZoomChange(zoomValue);
    }
  };

  const zoomOut = () => {
    const lowerPreset = availableZoomPresets.findLast((p) => p < zoom);
    if (lowerPreset !== undefined) {
      onZoomChange(lowerPreset);
    }
  };

  const zoomIn = () => {
    const higherPreset = availableZoomPresets.find((p) => p > zoom);
    if (higherPreset !== undefined) {
      onZoomChange(higherPreset);
    }
  };

  const canZoomOut = availableZoomPresets.length > 0 && zoom > availableZoomPresets[0]!;
  const canZoomIn =
    availableZoomPresets.length > 0 &&
    zoom < availableZoomPresets[availableZoomPresets.length - 1]!;

  return (
    <>
      <Button
        isDisabled={!canZoomOut}
        variant="ghost-muted"
        size="xs"
        onClick={zoomOut}
        mode="icon-only"
        icon={MinusIcon}
        aria-label={labels.zoomOut}
        className="aria-disabled:text-icon-inverted-disabled"
      />
      <Input
        size="sm"
        type="text"
        inputMode="numeric"
        value={displayValue}
        onChange={handleChange}
        onFocus={handleFocus}
        onKeyDown={blurOnEnter}
        onBlur={applyZoom}
        aria-label={labels.zoomLevel}
        name="zoom-level"
        className="border-inverted/50 hover:border-inverted/60 text-white-default h-6 w-14 rounded-sm bg-(--transparent-light-4) p-0 text-center text-sm hover:bg-(--transparent-light-8)"
      />
      <Button
        isDisabled={!canZoomIn}
        variant="ghost-muted"
        size="xs"
        onClick={zoomIn}
        mode="icon-only"
        icon={PlusIcon}
        aria-label={labels.zoomIn}
        className="aria-disabled:text-icon-inverted-disabled"
      />
    </>
  );
}
