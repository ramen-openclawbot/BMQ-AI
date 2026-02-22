-- Keep only "Danh sách SKU thành phẩm" experience in SKU management
-- Cleanup data related to removed sections: batch coding + trace links

begin;

-- Remove batch trace materials first (child)
delete from public.production_batch_materials;

-- Remove generated batches (parent)
delete from public.production_batches;

-- Remove batch code pattern configs used by removed batch coding UI
delete from public.batch_code_patterns;

commit;
