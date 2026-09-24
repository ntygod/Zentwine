-- Only the disposable CI/Compose control database. Never run on an existing application database.
CREATE TABLE public.zentwine_test_guard (
  singleton boolean PRIMARY KEY CHECK (singleton),
  marker text NOT NULL CHECK (marker = 'zentwine-disposable-tests-v1')
);
INSERT INTO public.zentwine_test_guard VALUES (true, 'zentwine-disposable-tests-v1');
