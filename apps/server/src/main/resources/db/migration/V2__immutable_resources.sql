CREATE FUNCTION immutable_resource() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.kind <> 'proposal' THEN RAISE EXCEPTION 'immutable resource'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER immutable_resource BEFORE UPDATE OR DELETE ON resources FOR EACH ROW EXECUTE FUNCTION immutable_resource();
