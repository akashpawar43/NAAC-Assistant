import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type MetricDetail } from "../../api";

/** One metric of a report. `reload` keeps the current detail on screen while it refetches. */
export function useMetric(cycleId: string, metricId: string) {
  const [detail, setDetail] = useState<MetricDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      setDetail(await api.get<MetricDetail>(`/api/v1/cycles/${cycleId}/metrics/${metricId}`));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not load metric");
    }
  }, [cycleId, metricId]);

  useEffect(() => {
    setDetail(null);
    void reload();
  }, [reload]);

  return { detail, error, reload };
}
