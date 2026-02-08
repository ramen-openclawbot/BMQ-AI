-- Delete the invalid user account (profile will be deleted automatically via CASCADE)
DELETE FROM auth.users WHERE id = '0ad6deb3-d2aa-4824-8ee6-72901be95c18';