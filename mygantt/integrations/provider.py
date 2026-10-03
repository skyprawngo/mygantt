"""Provider-neutral calendar adapter contract; no external provider is connected."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class CalendarProvider(ABC):
  """Future provider adapters should implement explicit auth and sync operations."""

  provider_key: str

  @abstractmethod
  def export_events(self, project: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert one project into provider-neutral calendar event records."""
    raise NotImplementedError

  @abstractmethod
  def import_events(self, events: list[dict[str, Any]]) -> None:
    """Apply externally received events only after a separate user-authorized flow."""
    raise NotImplementedError
