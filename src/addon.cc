/*
 * node-addon-api wrapper. Holds the aligned table behind
 * an external ArrayBuffer (the single owner of the allocation), selects a
 * kernel at load time, and exposes the marshalling-tier API. All config
 * validation is done in JS before crossing; native trusts the resolved, frozen
 * config.
 */
#include <napi.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#if !defined(_WIN32)
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

#include "cpu_features.h"
#include "kernels.h"
#include "third_party/rapidhash.h"

namespace {

const thoth_kernel_t *g_kernel = nullptr;

enum Mode { MODE_FAST = 0, MODE_CLASSIC = 1 };
enum HashId { HASH_RAPID = 0, HASH_XXH3 = 1, HASH_SIPHASH = 2 };

#if defined(_WIN32)
static void *aligned_alloc64(size_t bytes) {
	return _aligned_malloc(bytes, 64);
}
static void aligned_free64(void *p) { _aligned_free(p); }
#else
static void *aligned_alloc64(size_t bytes) {
	void *p = nullptr;
	if (posix_memalign(&p, 64, bytes) != 0)
		return nullptr;
	return p;
}
static void aligned_free64(void *p) { free(p); }
#endif

class IngestWorker; // libuv-pool file reader (Tier 0/1)

class Bloom : public Napi::ObjectWrap<Bloom> {
  public:
	static Napi::Function Init(Napi::Env env);
	Bloom(const Napi::CallbackInfo &info);

  private:
	friend class IngestWorker;
	// sizing / geometry
	int mode_ = MODE_FAST;
	uint32_t blockBits_ = 256;
	uint32_t lanesPerBlock_ = 8; // 8 (256) or 16 (512)
	uint32_t wordsPerBlock_ = 8;
	uint32_t k_ = 8;
	uint32_t nblk_ = 1;
	size_t nwords_ = 8;
	int hashId_ = HASH_RAPID;
	uint64_t seed_ = 0;

	uint32_t *table_ = nullptr; // owned by the external ArrayBuffer finalizer
	Napi::Reference<Napi::ArrayBuffer> abRef_;

	// Streaming carry: trailing partial record from the previous chunk,
	// held across createIngestStream pushes. One stream at a time per filter.
	std::string ingestCarry_;

	// ---- hashing ----------------------------------------------------------
	inline uint64_t hashBytes(const uint8_t *p, size_t len) const {
		// Only rapidhash is wired today; xxh3/siphash are future phases.
		return rapidhash_withSeed(p, len, seed_);
	}

	void insertHashes(const uint64_t *h, size_t n);
	void queryHashes(const uint64_t *h, size_t n, uint8_t *out);

	// ---- streaming / file ingestion ---------------------------------------
	// Split one in-memory region on `delim`, inserting every complete record;
	// a trailing partial record is appended to `carry` for the next region.
	// Returns the number of records inserted. No V8 access, safe off-thread.
	size_t processRegion(const uint8_t *data, size_t len, uint8_t delim,
						 std::string &carry);
	// Buffered (fread) and mmap whole-file readers. Off-thread safe; fill
	// `outCount`/`outErr`, return false on I/O error.
	bool ingestFileBuffered(const char *path, uint8_t delim, uint64_t &outCount,
							std::string &outErr);
	bool ingestFileMapped(const char *path, uint8_t delim, uint64_t &outCount,
						  std::string &outErr);

	// ---- API methods ------------------------------------------------------
	Napi::Value Add(const Napi::CallbackInfo &info);
	Napi::Value Has(const Napi::CallbackInfo &info);
	Napi::Value AddAll(const Napi::CallbackInfo &info);
	Napi::Value HasAll(const Napi::CallbackInfo &info);
	Napi::Value AddHashes(const Napi::CallbackInfo &info);
	Napi::Value HasHashes(const Napi::CallbackInfo &info);
	Napi::Value AddInts(const Napi::CallbackInfo &info);
	Napi::Value HasInts(const Napi::CallbackInfo &info);
	Napi::Value AddDelimited(const Napi::CallbackInfo &info);
	Napi::Value IngestFile(const Napi::CallbackInfo &info);
	Napi::Value IngestFileAsync(const Napi::CallbackInfo &info);
	Napi::Value IngestFileMmap(const Napi::CallbackInfo &info);
	Napi::Value IngestPush(const Napi::CallbackInfo &info);
	Napi::Value IngestEnd(const Napi::CallbackInfo &info);
	Napi::Value Buffer(const Napi::CallbackInfo &info);
	Napi::Value OrWith(const Napi::CallbackInfo &info);
	Napi::Value AndWith(const Napi::CallbackInfo &info);

	bool sameGeometry(const Bloom *o) const {
		return o->mode_ == mode_ && o->blockBits_ == blockBits_ &&
			   o->k_ == k_ && o->nblk_ == nblk_ && o->hashId_ == hashId_ &&
			   o->seed_ == seed_;
	}

	// helper: read a value's bytes (String -> utf8, Buffer/TypedArray -> raw)
	static const uint8_t *bytesOf(Napi::Value v, std::string &scratch,
								  size_t &len);
};

void Bloom::insertHashes(const uint64_t *h, size_t n) {
	if (mode_ == MODE_CLASSIC) {
		thoth_classic_insert_many(table_, nblk_, k_, wordsPerBlock_, h, n);
	} else if (blockBits_ == 256) {
		g_kernel->sbbf256_insert_many(table_, nblk_, h, n);
	} else {
		g_kernel->sbbf512_insert_many(table_, nblk_, h, n);
	}
}

void Bloom::queryHashes(const uint64_t *h, size_t n, uint8_t *out) {
	if (mode_ == MODE_CLASSIC) {
		thoth_classic_query_many(table_, nblk_, k_, wordsPerBlock_, h, n, out);
	} else if (blockBits_ == 256) {
		g_kernel->sbbf256_query_many(table_, nblk_, h, n, out);
	} else {
		g_kernel->sbbf512_query_many(table_, nblk_, h, n, out);
	}
}

const uint8_t *Bloom::bytesOf(Napi::Value v, std::string &scratch,
							  size_t &len) {
	if (v.IsString()) {
		scratch = v.As<Napi::String>().Utf8Value();
		len = scratch.size();
		return reinterpret_cast<const uint8_t *>(scratch.data());
	}
	if (v.IsBuffer()) {
		auto b = v.As<Napi::Buffer<uint8_t>>();
		len = b.Length();
		return b.Data();
	}
	if (v.IsTypedArray()) {
		auto ta = v.As<Napi::TypedArray>();
		auto ab = ta.ArrayBuffer();
		len = ta.ByteLength();
		return reinterpret_cast<const uint8_t *>(ab.Data()) + ta.ByteOffset();
	}
	len = 0;
	return reinterpret_cast<const uint8_t *>("");
}

Bloom::Bloom(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Bloom>(info) {
	Napi::Env env = info.Env();
	Napi::Object cfg = info[0].As<Napi::Object>();

	mode_ = cfg.Get("mode").As<Napi::Number>().Int32Value();
	blockBits_ = cfg.Get("blockBits").As<Napi::Number>().Uint32Value();
	k_ = cfg.Get("k").As<Napi::Number>().Uint32Value();
	nblk_ = cfg.Get("nblk").As<Napi::Number>().Uint32Value();
	hashId_ = cfg.Get("hashId").As<Napi::Number>().Int32Value();
	{
		bool lossless = false;
		seed_ = cfg.Get("seed").As<Napi::BigInt>().Uint64Value(&lossless);
	}
	lanesPerBlock_ = (blockBits_ == 512) ? 16 : 8;
	wordsPerBlock_ = lanesPerBlock_; // one uint32 lane-word per lane
	nwords_ = (size_t)nblk_ * wordsPerBlock_;

	size_t logicalBytes = nwords_ * sizeof(uint32_t);
	size_t allocBytes = (logicalBytes + 63) & ~(size_t)63;
	table_ = static_cast<uint32_t *>(aligned_alloc64(allocBytes));
	if (!table_) {
		Napi::Error::New(env, "BloomFilter: failed to allocate table")
			.ThrowAsJavaScriptException();
		return;
	}
	std::memset(table_, 0, allocBytes);

	// Optional: adopt initial bytes (fromBuffer load path). One copy at
	// load.
	if (cfg.Has("initialBytes")) {
		Napi::Value ib = cfg.Get("initialBytes");
		if (ib.IsTypedArray() || ib.IsBuffer()) {
			std::string scratch;
			size_t len = 0;
			const uint8_t *src = bytesOf(ib, scratch, len);
			std::memcpy(table_, src, len < logicalBytes ? len : logicalBytes);
		}
	}

	// External ArrayBuffer is the single owner; its finalizer frees the table.
	Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(
		env, table_, logicalBytes,
		[](Napi::Env, void *data) { aligned_free64(data); });
	abRef_ = Napi::Persistent(ab);
}

Napi::Value Bloom::Add(const Napi::CallbackInfo &info) {
	std::string scratch;
	size_t len = 0;
	const uint8_t *p = bytesOf(info[0], scratch, len);
	uint64_t h = hashBytes(p, len);
	insertHashes(&h, 1);
	return info.Env().Undefined();
}

Napi::Value Bloom::Has(const Napi::CallbackInfo &info) {
	std::string scratch;
	size_t len = 0;
	const uint8_t *p = bytesOf(info[0], scratch, len);
	uint64_t h = hashBytes(p, len);
	uint8_t out = 0;
	queryHashes(&h, 1, &out);
	return Napi::Boolean::New(info.Env(), out != 0);
}

Napi::Value Bloom::AddAll(const Napi::CallbackInfo &info) {
	Napi::Array arr = info[0].As<Napi::Array>();
	uint32_t n = arr.Length();
	std::vector<uint64_t> h(n);
	std::string scratch;
	for (uint32_t i = 0; i < n; ++i) {
		size_t len = 0;
		const uint8_t *p = bytesOf(arr.Get(i), scratch, len);
		h[i] = hashBytes(p, len);
	}
	insertHashes(h.data(), n);
	return Napi::Number::New(info.Env(), n);
}

Napi::Value Bloom::HasAll(const Napi::CallbackInfo &info) {
	Napi::Array arr = info[0].As<Napi::Array>();
	uint32_t n = arr.Length();
	std::vector<uint64_t> h(n);
	std::string scratch;
	for (uint32_t i = 0; i < n; ++i) {
		size_t len = 0;
		const uint8_t *p = bytesOf(arr.Get(i), scratch, len);
		h[i] = hashBytes(p, len);
	}
	Napi::Uint8Array out = Napi::Uint8Array::New(info.Env(), n);
	queryHashes(h.data(), n, out.Data());
	return out;
}

Napi::Value Bloom::AddHashes(const Napi::CallbackInfo &info) {
	Napi::BigUint64Array a = info[0].As<Napi::BigUint64Array>();
	insertHashes(reinterpret_cast<const uint64_t *>(a.Data()),
				 a.ElementLength());
	return Napi::Number::New(info.Env(), (double)a.ElementLength());
}

Napi::Value Bloom::HasHashes(const Napi::CallbackInfo &info) {
	Napi::BigUint64Array a = info[0].As<Napi::BigUint64Array>();
	size_t n = a.ElementLength();
	Napi::Uint8Array out = Napi::Uint8Array::New(info.Env(), n);
	queryHashes(reinterpret_cast<const uint64_t *>(a.Data()), n, out.Data());
	return out;
}

Napi::Value Bloom::AddInts(const Napi::CallbackInfo &info) {
	Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
	size_t n = ta.ElementLength();
	std::vector<uint64_t> h(n);
	if (ta.TypedArrayType() == napi_biguint64_array) {
		auto a = ta.As<Napi::BigUint64Array>();
		for (size_t i = 0; i < n; ++i)
			h[i] = rapid_splitmix(a[i], seed_);
	} else {
		auto a = ta.As<Napi::Uint32Array>();
		for (size_t i = 0; i < n; ++i)
			h[i] = rapid_splitmix((uint64_t)a[i], seed_);
	}
	insertHashes(h.data(), n);
	return Napi::Number::New(info.Env(), (double)n);
}

Napi::Value Bloom::HasInts(const Napi::CallbackInfo &info) {
	Napi::TypedArray ta = info[0].As<Napi::TypedArray>();
	size_t n = ta.ElementLength();
	std::vector<uint64_t> h(n);
	if (ta.TypedArrayType() == napi_biguint64_array) {
		auto a = ta.As<Napi::BigUint64Array>();
		for (size_t i = 0; i < n; ++i)
			h[i] = rapid_splitmix(a[i], seed_);
	} else {
		auto a = ta.As<Napi::Uint32Array>();
		for (size_t i = 0; i < n; ++i)
			h[i] = rapid_splitmix((uint64_t)a[i], seed_);
	}
	Napi::Uint8Array out = Napi::Uint8Array::New(info.Env(), n);
	queryHashes(h.data(), n, out.Data());
	return out;
}

// Split one region on `delim`, inserting each complete record. A trailing
// partial record (no delimiter yet) is carried into `carry` for the next call;
// empty records (consecutive delimiters) are skipped, matching addDelimited.
size_t Bloom::processRegion(const uint8_t *data, size_t len, uint8_t delim,
							std::string &carry) {
	std::vector<uint64_t> h;
	h.reserve(len / 8 + 1);
	size_t start = 0;
	for (size_t i = 0; i < len; ++i) {
		if (data[i] != delim)
			continue;
		size_t seglen = i - start;
		if (!carry.empty()) {
			// record spans the chunk boundary: prefix + this segment.
			carry.append(reinterpret_cast<const char *>(data + start), seglen);
			h.push_back(hashBytes(
				reinterpret_cast<const uint8_t *>(carry.data()), carry.size()));
			carry.clear();
		} else if (seglen > 0) {
			h.push_back(hashBytes(data + start, seglen));
		}
		start = i + 1;
	}
	if (start < len) // trailing partial record, carry to next region
		carry.append(reinterpret_cast<const char *>(data + start), len - start);
	insertHashes(h.data(), h.size());
	return h.size();
}

bool Bloom::ingestFileBuffered(const char *path, uint8_t delim,
							   uint64_t &outCount, std::string &outErr) {
	FILE *f = std::fopen(path, "rb");
	if (!f) {
		outErr = std::string("BloomFilter: cannot open file: ") + path;
		return false;
	}
	const size_t INGEST_CHUNK = 1u << 16; // 64 KiB blocks
	std::vector<uint8_t> buf(INGEST_CHUNK);
	std::string carry;
	uint64_t count = 0;
	size_t r;
	while ((r = std::fread(buf.data(), 1, INGEST_CHUNK, f)) > 0)
		count += processRegion(buf.data(), r, delim, carry);
	bool err = std::ferror(f) != 0;
	std::fclose(f);
	if (err) {
		outErr = std::string("BloomFilter: read error on file: ") + path;
		return false;
	}
	if (!carry.empty()) { // final record without a trailing delimiter
		uint64_t h = hashBytes(reinterpret_cast<const uint8_t *>(carry.data()),
							   carry.size());
		insertHashes(&h, 1);
		count += 1;
	}
	outCount = count;
	return true;
}

bool Bloom::ingestFileMapped(const char *path, uint8_t delim,
							 uint64_t &outCount, std::string &outErr) {
#if defined(_WIN32)
	// No POSIX mmap on Windows, so fall back to the buffered reader.
	return ingestFileBuffered(path, delim, outCount, outErr);
#else
	int fd = ::open(path, O_RDONLY);
	if (fd < 0) {
		outErr = std::string("BloomFilter: cannot open file: ") + path;
		return false;
	}
	struct stat st;
	if (::fstat(fd, &st) != 0) {
		::close(fd);
		outErr = std::string("BloomFilter: cannot stat file: ") + path;
		return false;
	}
	size_t len = (size_t)st.st_size;
	if (len == 0) {
		::close(fd);
		outCount = 0;
		return true;
	}
	void *m = ::mmap(nullptr, len, PROT_READ, MAP_PRIVATE, fd, 0);
	::close(fd);
	if (m == MAP_FAILED) {
		outErr = std::string("BloomFilter: mmap failed for file: ") + path;
		return false;
	}
	::madvise(m, len, MADV_SEQUENTIAL);
	std::string carry;
	uint64_t count =
		processRegion(static_cast<const uint8_t *>(m), len, delim, carry);
	if (!carry.empty()) {
		uint64_t h = hashBytes(reinterpret_cast<const uint8_t *>(carry.data()),
							   carry.size());
		insertHashes(&h, 1);
		count += 1;
	}
	::munmap(m, len);
	outCount = count;
	return true;
#endif
}

Napi::Value Bloom::AddDelimited(const Napi::CallbackInfo &info) {
	auto buf = info[0].As<Napi::Buffer<uint8_t>>();
	uint8_t delim = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
	// One-shot buffer: no cross-call carry, so flush the tail as a record.
	std::string carry;
	size_t count = processRegion(buf.Data(), buf.Length(), delim, carry);
	if (!carry.empty()) {
		uint64_t h = hashBytes(reinterpret_cast<const uint8_t *>(carry.data()),
							   carry.size());
		insertHashes(&h, 1);
		count += 1;
	}
	return Napi::Number::New(info.Env(), (double)count);
}

// Synchronous buffered file ingest. Blocks the event loop; for hot paths
// prefer ingestFileAsync.
Napi::Value Bloom::IngestFile(const Napi::CallbackInfo &info) {
	std::string path = info[0].As<Napi::String>().Utf8Value();
	uint8_t delim = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
	uint64_t count = 0;
	std::string err;
	if (!ingestFileBuffered(path.c_str(), delim, count, err)) {
		Napi::Error::New(info.Env(), err).ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}
	return Napi::Number::New(info.Env(), (double)count);
}

// One chunk from a Node stream (Tier 1): split natively, carry the
// partial tail in ingestCarry_ for the next push. Returns records inserted.
Napi::Value Bloom::IngestPush(const Napi::CallbackInfo &info) {
	auto buf = info[0].As<Napi::Buffer<uint8_t>>();
	uint8_t delim = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
	size_t count = processRegion(buf.Data(), buf.Length(), delim, ingestCarry_);
	return Napi::Number::New(info.Env(), (double)count);
}

// End of stream: flush any carried final record (no trailing delimiter).
Napi::Value Bloom::IngestEnd(const Napi::CallbackInfo &info) {
	uint64_t count = 0;
	if (!ingestCarry_.empty()) {
		uint64_t h =
			hashBytes(reinterpret_cast<const uint8_t *>(ingestCarry_.data()),
					  ingestCarry_.size());
		insertHashes(&h, 1);
		ingestCarry_.clear();
		count = 1;
	}
	return Napi::Number::New(info.Env(), (double)count);
}

// Reads a file on the libuv pool and inserts off the event loop,
// resolving a Promise<count>. Holds a ref on the wrapper so the table stays
// alive across the worker. `useMmap` picks the mmap reader.
class IngestWorker : public Napi::AsyncWorker {
  public:
	IngestWorker(Napi::Env env, Bloom *bloom, std::string path, uint8_t delim,
				 bool useMmap)
		: Napi::AsyncWorker(env), deferred_(Napi::Promise::Deferred::New(env)),
		  bloom_(bloom), path_(std::move(path)), delim_(delim),
		  useMmap_(useMmap) {
		bloom_->Ref(); // keep the table alive while we read into it
	}

	Napi::Promise Promise() { return deferred_.Promise(); }

  protected:
	void Execute() override {
		std::string err;
		bool ok = useMmap_ ? bloom_->ingestFileMapped(path_.c_str(), delim_,
													  count_, err)
						   : bloom_->ingestFileBuffered(path_.c_str(), delim_,
														count_, err);
		if (!ok)
			SetError(err);
	}
	void OnOK() override {
		bloom_->Unref();
		deferred_.Resolve(Napi::Number::New(Env(), (double)count_));
	}
	void OnError(const Napi::Error &e) override {
		bloom_->Unref();
		deferred_.Reject(e.Value());
	}

  private:
	Napi::Promise::Deferred deferred_;
	Bloom *bloom_;
	std::string path_;
	uint8_t delim_;
	bool useMmap_;
	uint64_t count_ = 0;
};

Napi::Value Bloom::IngestFileAsync(const Napi::CallbackInfo &info) {
	std::string path = info[0].As<Napi::String>().Utf8Value();
	uint8_t delim = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
	auto *w = new IngestWorker(info.Env(), this, std::move(path), delim, false);
	Napi::Promise p = w->Promise();
	w->Queue();
	return p;
}

Napi::Value Bloom::IngestFileMmap(const Napi::CallbackInfo &info) {
	std::string path = info[0].As<Napi::String>().Utf8Value();
	uint8_t delim = (uint8_t)info[1].As<Napi::Number>().Uint32Value();
	auto *w = new IngestWorker(info.Env(), this, std::move(path), delim, true);
	Napi::Promise p = w->Promise();
	w->Queue();
	return p;
}

Napi::Value Bloom::Buffer(const Napi::CallbackInfo &info) {
	return abRef_.Value();
}

Napi::Value Bloom::OrWith(const Napi::CallbackInfo &info) {
	Bloom *o = Napi::ObjectWrap<Bloom>::Unwrap(info[0].As<Napi::Object>());
	if (!sameGeometry(o)) {
		Napi::Error::New(info.Env(),
						 "BloomFilter: union requires identical geometry")
			.ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}
	g_kernel->or_words(table_, o->table_, nwords_);
	return info.Env().Undefined();
}

Napi::Value Bloom::AndWith(const Napi::CallbackInfo &info) {
	Bloom *o = Napi::ObjectWrap<Bloom>::Unwrap(info[0].As<Napi::Object>());
	if (!sameGeometry(o)) {
		Napi::Error::New(info.Env(),
						 "BloomFilter: intersect requires identical geometry")
			.ThrowAsJavaScriptException();
		return info.Env().Undefined();
	}
	g_kernel->and_words(table_, o->table_, nwords_);
	return info.Env().Undefined();
}

Napi::Function Bloom::Init(Napi::Env env) {
	return DefineClass(
		env, "Bloom",
		{
			InstanceMethod<&Bloom::Add>("add"),
			InstanceMethod<&Bloom::Has>("has"),
			InstanceMethod<&Bloom::AddAll>("addAll"),
			InstanceMethod<&Bloom::HasAll>("hasAll"),
			InstanceMethod<&Bloom::AddHashes>("addHashes"),
			InstanceMethod<&Bloom::HasHashes>("hasHashes"),
			InstanceMethod<&Bloom::AddInts>("addInts"),
			InstanceMethod<&Bloom::HasInts>("hasInts"),
			InstanceMethod<&Bloom::AddDelimited>("addDelimited"),
			InstanceMethod<&Bloom::IngestFile>("ingestFile"),
			InstanceMethod<&Bloom::IngestFileAsync>("ingestFileAsync"),
			InstanceMethod<&Bloom::IngestFileMmap>("ingestFileMmap"),
			InstanceMethod<&Bloom::IngestPush>("ingestPush"),
			InstanceMethod<&Bloom::IngestEnd>("ingestEnd"),
			InstanceMethod<&Bloom::Buffer>("buffer"),
			InstanceMethod<&Bloom::OrWith>("orWith"),
			InstanceMethod<&Bloom::AndWith>("andWith"),
		});
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
	// Runtime kernel dispatch: AVX2 if available, else scalar.
	// THOTH_FORCE_KERNEL=scalar|avx2 pins a kernel (used by the parity tests).
	const thoth_kernel_t *avx2 = thoth_kernel_avx2();
	const char *force = std::getenv("THOTH_FORCE_KERNEL");
	if (force && std::strcmp(force, "scalar") == 0) {
		g_kernel = thoth_kernel_scalar();
	} else if (force && std::strcmp(force, "avx2") == 0) {
		g_kernel = avx2 ? avx2 : thoth_kernel_scalar();
	} else if (avx2 && thoth_cpu_has_avx2()) {
		g_kernel = avx2;
	} else {
		g_kernel = thoth_kernel_scalar();
	}

	exports.Set("Bloom", Bloom::Init(env));
	exports.Set("kernelName", Napi::String::New(env, g_kernel->name));
	return exports;
}

} // namespace

NODE_API_MODULE(addon, Init)
