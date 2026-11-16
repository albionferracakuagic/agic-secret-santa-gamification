CREATE OR REPLACE FUNCTION gifts_reveal_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.giver_revealed_at IS NOT NULL
     AND (NEW.giver_revealed_at IS DISTINCT FROM OLD.giver_revealed_at OR NEW.status <> 'revealed') THEN
    RAISE EXCEPTION 'gift giver reveal is irreversible' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER gifts_reveal_immutable BEFORE UPDATE ON gifts
FOR EACH ROW EXECUTE FUNCTION gifts_reveal_immutable();
