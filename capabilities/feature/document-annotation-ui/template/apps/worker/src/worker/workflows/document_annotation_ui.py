"""Document Annotation UI workflows contributed by the capability package.

The implementation lives in the reusable Python distribution. This lets
package-level tests run the review workflow without the full app. The import
keeps the app-local ``workflows`` discovery seam aligned with the speech shape.
"""

from mistralai_capabilities.document_annotation_ui.workflow import DocumentExtractionWorkflow

__all__ = ["DocumentExtractionWorkflow"]
