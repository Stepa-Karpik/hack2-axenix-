-- Locate one immutable analysis by provenance without decompressing every prior graph payload.
CREATE INDEX analysis_revision_environment
ON resources(project_id,(data->>'revisionId'),(data->>'analyzerVersion'),
             (data->>'sourceMapVersion'),(data->>'symbolEnvironmentHash'),created_at DESC,id DESC)
WHERE kind='analysis';
