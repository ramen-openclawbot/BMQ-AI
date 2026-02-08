-- Add bank_account_name column to suppliers table for UNC matching
ALTER TABLE suppliers 
ADD COLUMN bank_account_name text;

COMMENT ON COLUMN suppliers.bank_account_name IS 
  'Tên tài khoản ngân hàng của NCC (dùng để matching UNC)';