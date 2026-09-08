import { useEffect, useState } from "react";

const DISABLED = Object.freeze({ gradeOpsEnabled: false, loading: false });

export function useAccountFeatures({ client = null, profileId }) {
  const developmentPreview = import.meta.env.DEV
    && typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("grade-ops-preview") === "1";
  const [features, setFeatures] = useState(() => ({ gradeOpsEnabled: developmentPreview, loading: Boolean(client && profileId) }));

  useEffect(() => {
    if (!client || !profileId) {
      setFeatures(developmentPreview ? { gradeOpsEnabled: true, loading: false } : DISABLED);
      return undefined;
    }
    let current = true;
    setFeatures({ gradeOpsEnabled: false, loading: true });
    client
      .from("account_features")
      .select("grade_ops_enabled")
      .eq("user_id", profileId)
      .maybeSingle()
      .then((result) => {
        if (!current) return;
        setFeatures({
          gradeOpsEnabled: !result.error && result.data?.grade_ops_enabled === true,
          loading: false,
        });
      })
      .catch(() => {
        if (current) setFeatures(developmentPreview ? { gradeOpsEnabled: true, loading: false } : DISABLED);
      });
    return () => { current = false; };
  }, [client, developmentPreview, profileId]);

  return features;
}
