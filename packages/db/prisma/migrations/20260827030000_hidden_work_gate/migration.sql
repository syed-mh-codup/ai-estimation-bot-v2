-- AEH-263: admin switch between warning about unresolved hidden work and
-- blocking finalisation on it.
--
-- Defaults to false (warn) deliberately. A blocking gate is only as good as the
-- Detective's precision, and this stage has never run against a real SOW -- it
-- was written and left unwired. Starting in warn mode lets a team see what it
-- actually catches before it is allowed to stand between them and sending an
-- estimate. Flipping it on is one admin edit, no deploy.
ALTER TABLE "EstimationConfig" ADD COLUMN "hiddenWorkBlocksFinalise" BOOLEAN NOT NULL DEFAULT false;
