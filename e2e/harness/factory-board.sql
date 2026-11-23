-- The factory board alone, for the GPU proof's fixture (gpu-proof.spec.ts header).
--
-- Run into a new, empty file with the source database attached read-only as
-- `src`; the source is never written and is not copied:
--
--   sqlite3 /tmp/junto-board.db \
--     "ATTACH 'file:$HOME/.junto/state/junto.db?mode=ro' AS src" \
--     ".read e2e/harness/factory-board.sql"
--
-- It keeps what loadFactoryShapeCanvas reads (nested-canvas-fixture.ts) and
-- nothing else: the canvas row named factory; id, z order and rect from every
-- card table, colour from regions, the card's kind as its table; ends and
-- verb from wires, numbered in their order in place of their ids. No mail,
-- sessions, signals, settings, devices, names or text.

CREATE TABLE canvases AS SELECT canvas_name FROM src.canvases WHERE canvas_name = 'factory';
CREATE TABLE seats AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.seats WHERE canvas_name = 'factory';
CREATE TABLE regions AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height, color FROM src.regions WHERE canvas_name = 'factory';
CREATE TABLE terminals AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.terminals WHERE canvas_name = 'factory';
CREATE TABLE pages AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.pages WHERE canvas_name = 'factory';
CREATE TABLE task_boards AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.task_boards WHERE canvas_name = 'factory';
CREATE TABLE artifact_boards AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.artifact_boards WHERE canvas_name = 'factory';
CREATE TABLE automation_boards AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.automation_boards WHERE canvas_name = 'factory';
CREATE TABLE notes AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.notes WHERE canvas_name = 'factory';
CREATE TABLE labels AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.labels WHERE canvas_name = 'factory';
CREATE TABLE file_cards AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.file_cards WHERE canvas_name = 'factory';
CREATE TABLE link_cards AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.link_cards WHERE canvas_name = 'factory';
CREATE TABLE git_repositories AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.git_repositories WHERE canvas_name = 'factory';
CREATE TABLE file_trees AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.file_trees WHERE canvas_name = 'factory';
CREATE TABLE stubs AS SELECT 'factory' AS canvas_name, id, z_index, x, y, width, height FROM src.stubs WHERE canvas_name = 'factory';
CREATE TABLE wires AS SELECT 'factory' AS canvas_name, row_number() OVER (ORDER BY id) AS id, from_id, to_id, verb FROM src.wires WHERE canvas_name = 'factory';
DETACH src;
