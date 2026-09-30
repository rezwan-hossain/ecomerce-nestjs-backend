import { Test, TestingModule } from '@nestjs/testing';
import { ReviewsController } from './reviews.controller';
import { ReviewsService } from './reviews.service';

describe('ReviewsController', () => {
  let controller: ReviewsController;
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findForProduct: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    moderate: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReviewsController],
      providers: [{ provide: ReviewsService, useValue: service }],
    }).compile();

    controller = module.get<ReviewsController>(ReviewsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('passes the reviewer userId from the query to the service', async () => {
    const dto = { productId: 'p1', rating: 4 };

    await controller.create({ userId: 'u1' }, dto);

    expect(service.create).toHaveBeenCalledWith('u1', dto);
  });
});
